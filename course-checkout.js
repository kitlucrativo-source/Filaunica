/**
 * PIX para vendas reais de cursos. Independente das filas, bônus e saques.
 * Não publicar cursos sem material pronto em course-content/<id>.txt.
 */
import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT,transaction} from './store.js';
import {createPixPayment,getPayment,paymentsConfigured,verifyMercadoPagoWebhook} from './payments.js';

const CONTENT_DIR=path.join(ROOT,'course-content');
const statuses=new Set(['pending','in_process','approved','rejected','cancelled','refunded','charged_back']);
const cents=v=>Math.round(Number(v)*100);

function publishedCatalog(){
  const items=JSON.parse(readFileSync(path.join(ROOT,'courses.json'),'utf8'));
  if(!Array.isArray(items))throw new Error('courses.json deve ser uma lista.');
  const seen=new Set();
  return items.filter(p=>{
    if(!p||typeof p.id!=='string'||!/^[a-z0-9-]{3,64}$/.test(p.id)||
      seen.has(p.id)||typeof p.title!=='string'||p.title.length<4||p.title.length>120||
      typeof p.description!=='string'||p.description.length>600||
      !Number.isSafeInteger(p.priceCents)||p.priceCents<100)throw new Error('Catálogo inválido.');
    seen.add(p.id);
    if(!p.published)return false;
    if(!existsSync(path.join(CONTENT_DIR,p.id+'.txt')))throw new Error('Curso publicado sem arquivo de conteúdo: '+p.id);
    return true;
  });
}
function safeTicket(value){
  try{const url=new URL(value);
    return url.protocol==='https:'&&(url.hostname==='mercadopago.com.br'||url.hostname.endsWith('.mercadopago.com.br'))?url.href:null;
  }catch{return null;}
}
export function createCourseCheckout({db,origin,fail,send,body,limit}){
  const products=publishedCatalog(),byId=new Map(products.map(p=>[p.id,p]));
  const enabled=process.env.ENABLE_COURSE_PIX==='true'&&paymentsConfigured()&&origin.startsWith('https://');
  db.exec(
    'CREATE TABLE IF NOT EXISTS course_orders ('+
    'id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),'+
    'course_id TEXT NOT NULL,title TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),'+
    "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_process','approved','rejected','cancelled','refunded','charged_back')),"+
    'mp_payment_id TEXT UNIQUE,qr_code TEXT,qr_code_base64 TEXT,ticket_url TEXT,'+
    'created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);'+
    'CREATE INDEX IF NOT EXISTS course_orders_user_idx ON course_orders(user_id,created_at);'
  );
  const load=id=>db.prepare('SELECT * FROM course_orders WHERE id=?').get(id);
  const format=o=>({id:o.id,courseId:o.course_id,title:o.title,amountCents:o.amount_cents,status:o.status,
    pixCode:o.status==='pending'?o.qr_code:null,
    pixQRBase64:o.status==='pending'?o.qr_code_base64:null,
    ticketUrl:o.status==='pending'?safeTicket(o.ticket_url):null,
    createdAt:o.created_at});
  function verifyPayment(payment,order){
    if(!payment||String(payment.id)!==String(order.mp_payment_id)||
      payment.external_reference!=='course-sale:'+order.id||payment.payment_method_id!=='pix'||
      payment.currency_id!=='BRL'||cents(payment.transaction_amount)!==order.amount_cents)
      fail(502,'Pagamento não corresponde à compra cadastrada.');
  }
  async function reconcile(order,payment){
    verifyPayment(payment,order);
    const status=statuses.has(payment.status)?payment.status:'pending';
    if(status!==order.status)transaction(db,()=>{
      db.prepare('UPDATE course_orders SET status=?,updated_at=? WHERE id=? AND mp_payment_id=?')
        .run(status,Date.now(),order.id,order.mp_payment_id);
      db.prepare('INSERT INTO audit(user_id,action,created_at) VALUES(?,?,?)')
        .run(order.user_id,'course_payment_'+status,Date.now());
    });
    return load(order.id);
  }
  async function webhook(req,res,url){
    const id=url.searchParams.get('data.id')||'';
    if(!/^\d{1,25}$/.test(id)||!verifyMercadoPagoWebhook(url,req.headers))
      fail(401,'Webhook sem assinatura válida.');
    limit('mp-webhook:'+(req.socket.remoteAddress||'unknown'),500,15*60*1000);
    let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384)fail(413,'Corpo muito grande.');}
    const payment=await getPayment(id),ref=String(payment.external_reference||'');
    if(!/^course-sale:[a-f0-9-]{36}$/.test(ref))return send(res,200,{ok:true});
    const order=load(ref.slice('course-sale:'.length));
    if(!order||String(order.mp_payment_id)!==String(payment.id))return send(res,200,{ok:true});
    await reconcile(order,payment);
    return send(res,200,{ok:true});
  }
  function list(res){
    return send(res,200,{enabled,courses:products.map(({id,title,description,priceCents})=>({id,title,description,priceCents}))});
  }
  async function userRoute(req,res,url,u){
    const route=url.pathname,method=req.method;
    if(method==='GET'&&route==='/api/course-orders'){
      const orders=db.prepare('SELECT * FROM course_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(u.id);
      return send(res,200,{orders:orders.map(format)});
    }
    if(method==='GET'&&route.startsWith('/api/course-orders/')){
      const id=route.slice('/api/course-orders/'.length);
      if(!/^[a-f0-9-]{36}$/.test(id))fail(404,'Compra não encontrada.');
      let order=load(id);
      if(!order||order.user_id!==u.id)fail(404,'Compra não encontrada.');
      if(enabled&&order.mp_payment_id&&['pending','in_process'].includes(order.status)&&Date.now()-order.updated_at>6000)
        order=await reconcile(order,await getPayment(order.mp_payment_id));
      return send(res,200,{order:format(order)});
    }
    if(method==='GET'&&route==='/api/my-courses'){
      const owned=db.prepare("SELECT DISTINCT course_id FROM course_orders WHERE user_id=? AND status='approved' ORDER BY course_id").all(u.id);
      return send(res,200,{courses:owned.map(x=>({id:x.course_id,title:byId.get(x.course_id)?.title||x.course_id}))});
    }
    if(method==='GET'&&route.startsWith('/api/course-content/')){
      const id=route.slice('/api/course-content/'.length);
      if(!/^[a-z0-9-]{3,64}$/.test(id))fail(404,'Curso não encontrado.');
      const owned=db.prepare("SELECT 1 FROM course_orders WHERE user_id=? AND course_id=? AND status='approved' LIMIT 1").get(u.id,id);
      if(!owned||!byId.has(id))fail(403,'Curso indisponível para esta conta.');
      const data=readFileSync(path.join(CONTENT_DIR,id+'.txt'));
      res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
      res.end(data);return;
    }
    if(method==='POST'&&route==='/api/courses/buy'){
      if(!enabled)fail(503,'Configure checkout, HTTPS e credenciais antes de vender.');
      limit('course-buy:'+u.id,12,15*60*1000);
      const b=await body(req),course=typeof b.courseId==='string'?byId.get(b.courseId):null;
      if(!course)fail(404,'Curso não disponível.');
      if(db.prepare("SELECT 1 FROM course_orders WHERE user_id=? AND course_id=? AND status='approved' LIMIT 1").get(u.id,course.id))
        fail(409,'Curso já adquirido.');
      let order=db.prepare("SELECT * FROM course_orders WHERE user_id=? AND course_id=? AND status IN ('pending','in_process') ORDER BY created_at DESC LIMIT 1").get(u.id,course.id);
      if(!order){
        const id=randomUUID(),now=Date.now();
        db.prepare('INSERT INTO course_orders(id,user_id,course_id,title,amount_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(id,u.id,course.id,course.title,course.priceCents,now,now);
        order=load(id);
      }
      if(order.mp_payment_id)return send(res,200,{order:format(order)});
      const doc=String(u.documento||'').replace(/\D/g,'');
      if(u.pais!=='BR'||![11,14].includes(doc.length))
        fail(422,'Cadastre seu CPF ou CNPJ brasileiro no perfil antes de pagar com Pix.');
      const payer={email:u.email,first_name:u.nome.trim().split(/\s+/)[0],
        identification:{type:doc.length===11?'CPF':'CNPJ',number:doc}};
      const payment=await createPixPayment({
        amount:order.amount_cents/100,description:'Curso: '+order.title,
        externalReference:'course-sale:'+order.id,
        notificationUrl:origin+'/api/webhooks/mercado-pago',
        payer,idempotencyKey:order.id
      });
      if(!payment?.id||payment.external_reference!=='course-sale:'+order.id||
        cents(payment.transaction_amount)!==order.amount_cents)
        fail(502,'Resposta incompleta do Mercado Pago. Compra permanece pendente.');
      const qr=payment.point_of_interaction?.transaction_data||{};
      db.prepare('UPDATE course_orders SET mp_payment_id=?,qr_code=?,qr_code_base64=?,ticket_url=?,updated_at=? WHERE id=? AND mp_payment_id IS NULL')
        .run(String(payment.id),String(qr.qr_code||'').slice(0,2000),
          String(qr.qr_code_base64||'').slice(0,350000),safeTicket(qr.ticket_url),Date.now(),order.id);
      return send(res,200,{order:format(load(order.id))});
    }
    fail(404,'Recurso de cursos não encontrado.');
  }
  return{enabled,list,userRoute,webhook};
}
