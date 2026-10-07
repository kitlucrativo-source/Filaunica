import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { issueReset, TABLE, ROOT, hash } from '../store.js';

async function launch(dir) {
  const app=createApp({dataDir:dir,appURL:'http://localhost:3000',production:false});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  app.url=`http://127.0.0.1:${app.server.address().port}`;
  return app;
}
function client(app) {
  return {cookie:'', async request(route,method='GET',body,headers={}){
    const res=await fetch(app.url+route,{method,headers:{Origin:'http://localhost:3000','X-Fila-Request':'1','Content-Type':'application/json',Cookie:this.cookie,...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const cookie=res.headers.get('set-cookie');if(cookie)this.cookie=cookie.split(';')[0];
    const data=res.headers.get('content-type')?.includes('json')?await res.json():await res.text();
    return {status:res.status,data,headers:res.headers};
  }};
}
const account=(login,extra={})=>({login,email:login+'@example.test',senha:'SenhaTeste123',nome:'Pessoa de teste',pais:'BR',documento:'00000000000',telefone:'11999999999',nivel:'bronze',...extra});

test('contas, isolamento, bloqueios financeiros, recuperação e persistência',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'fila-test-'));let app;
  try { app=await launch(dir); } catch(error) { await rm(dir,{recursive:true,force:true}); if(error.code==='EPERM'||error.code==='EACCES'){t.skip('Este ambiente não permite abrir portas loopback; execute npm test em Node.js local.');return;} throw error; }
  try{
    const a=client(app),b=client(app),guest=client(app);
    assert.equal((await guest.request('/api/dashboard')).status,401);
    assert.equal((await guest.request('/api/register','POST',account('invalido',{nivel:'__proto__'}))).status,400);
    assert.equal((await guest.request('/api/register','POST',account('fraca',{senha:'12345678'}))).status,400);
    assert.equal((await guest.request('/api/register','POST',account('falso',{sponsor:'naoexiste'}))).status,400);
    let r=await a.request('/api/register','POST',account('ana'));assert.equal(r.status,201);
    assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Lax/);
    assert.equal(r.data.user.password,undefined);assert.equal(r.data.user.status,'pending');
    const anaID=r.data.user.id;
    assert.match(app.db.prepare('SELECT password FROM users WHERE id=?').get(anaID).password,/^scrypt:/);
    assert.equal((await b.request('/api/register','POST',account('bia',{nivel:'ouro',sponsor:'ana'}))).status,201);
    assert.equal((await guest.request('/api/register','POST',account('ana'))).status,409);
    assert.equal((await guest.request('/api/login','POST',{login:'ana',senha:'errada'})).status,401);
    assert.equal((await guest.request('/api/reset','POST',{token:'fake',senha:'NovaSenha123'})).status,400);
    assert.equal((await a.request('/api/profile','PATCH',{nome:'Nome salvo',email:'ana@example.test',telefone:'11988888888',documento:'00000000000'})).status,200);
    assert.equal((await a.request('/api/profile','PATCH',{nome:'Nome salvo',email:'outra@example.test',telefone:'11988888888',documento:'00000000000'})).status,400);
    assert.equal((await a.request('/api/pix','PATCH',{pixTipo:'email',pixChave:'ana@example.test',titular:'Pessoa Teste',senhaAtual:'errada'})).status,400);
    assert.equal((await a.request('/api/pix','PATCH',{pixTipo:'email',pixChave:'ana@example.test',titular:'Pessoa Teste',senhaAtual:'SenhaTeste123'})).status,200);
    assert.equal((await a.request('/api/me')).data.user.pixChave,'ana@example.test');
    assert.equal((await b.request('/api/me')).data.user.pixChave,'');
    r=await a.request('/api/referrals');assert.equal(r.data.referrals.length,1);assert.equal(r.data.referrals[0].login,'bia');assert.equal(r.data.referrals[0].email,undefined);
    assert.equal((await b.request('/api/referrals')).data.referrals.length,0);
    assert.equal((await b.request('/api/admin')).status,403);
    app.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(anaID);
    assert.equal((await a.request('/api/admin')).data.users.length,2);
    assert.equal((await a.request('/api/orders','POST',{nivel:'prata',amount_cents:1,status:'approved',user_id:'other'})).data.order.status,'pending');
    r=await a.request('/api/orders','POST',{nivel:'prata'});assert.equal(r.data.order.amount_cents,6000);
    const orders=(await a.request('/api/dashboard')).data.orders;assert.equal(orders.length,2);
    assert.equal((await b.request('/api/dashboard?user_id='+anaID)).data.orders.length,1);
    assert.equal((await a.request('/api/checkout','POST',{order:orders[0].id,status:'approved'})).status,503);
    assert.equal((await a.request('/api/withdrawals','POST',{amount:3000,pix:'qualquer',saldo:1000000})).status,503);
    assert.equal((await a.request('/api/confirm','POST',{paid:true})).status,404);
    const d=(await a.request('/api/dashboard')).data;assert.equal(d.balanceCents,0);assert.equal(d.positions.length,0);assert.equal(d.cycles.length,0);
    assert.equal((await a.request('/api/orders','POST',{nivel:'bronze'},{Origin:'https://evil.example'})).status,403);
    assert.equal((await a.request('/api/orders','POST',{nivel:'bronze'},{'X-Fila-Request':''})).status,403);
    assert.equal((await guest.request('/server.js')).status,404);assert.equal((await guest.request('/.env')).status,404);assert.equal((await guest.request('/data/filadavez.sqlite')).status,404);
    const known=await guest.request('/api/recovery','POST',{login:'bia'}),unknown=await guest.request('/api/recovery','POST',{login:'desconhecido'});
    assert.deepEqual(known.data,unknown.data);assert.equal(known.status,202);
    const link=issueReset(app.db,'bia','http://localhost:3000'),value=new URLSearchParams(new URL(link).hash.slice(1)).get('token');
    assert.equal(app.db.prepare('SELECT digest FROM resets').get().digest,hash(value));
    assert.equal((await guest.request('/api/reset','POST',{token:value,senha:'NovaSenha123'})).status,200);
    assert.equal((await b.request('/api/me')).status,401);
    assert.equal((await guest.request('/api/reset','POST',{token:value,senha:'NovaSenha456'})).status,400);
    assert.equal((await b.request('/api/login','POST',{login:'bia',senha:'SenhaTeste123'})).status,401);
    assert.equal((await b.request('/api/login','POST',{login:'bia',senha:'NovaSenha123'})).status,200);
    const cookie=a.cookie;
    await new Promise(resolve=>app.server.close(resolve));app=await launch(dir);a.cookie=cookie;
    // O cliente mantém referência à instância anterior; atualizar URL para a nova porta.
    const restored=client(app);restored.cookie=cookie;
    assert.equal((await restored.request('/api/me')).data.user.nome,'Nome salvo');
    assert.equal((await restored.request('/api/dashboard')).data.orders.length,2);
    assert.equal((await restored.request('/api/logout','POST',{})).status,200);
    assert.equal((await restored.request('/api/me')).status,401);
  }finally{if(app?.server.listening) await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('tabela fiel à planilha, reservas e valores indefinidos',()=>{
  const expected={bronze:[3000,0],prata:[15000,6000],ouro:[20333,333],platina:[46667,6667],safira:[93333,13333],esmeralda:[186667,26667],rubi:[373333,53333]};
  for(const [nivel,values]of Object.entries(expected)){
    assert.deepEqual(TABLE[nivel].ciclos.map(c=>c.saque),values);
    for(const c of TABLE[nivel].ciclos)assert.equal(c.recebido+c.reserva_anterior,c.patrocinador+c.reentrada+c.reserva+c.subida_de_nivel+c.saque);
  }
  assert.equal(TABLE.bronze.ciclos[0].reserva,2000);assert.equal(TABLE.bronze.ciclos[1].reserva_anterior,2000);
  assert.equal(TABLE.diamante.ciclos[0].saque,null);assert.equal(TABLE.diamante.ciclos[0].saldo_provisorio,960000);
});

test('todas as páginas usam scripts externos e links locais existentes',async()=>{
  const files=await readdir(path.join(ROOT,'public'));
  for(const file of files.filter(f=>f.endsWith('.html'))){
    const text=await readFile(path.join(ROOT,'public',file),'utf8');
    assert(!/<script(?![^>]*src=)[^>]*>/i.test(text),file+' script inline');
    assert(!/on(?:click|submit)=/i.test(text),file+' handler inline');
    assert(text.includes('src="app.js"'),file);
    for(const [,url] of text.matchAll(/(?:href|src)="([^"#]+)"/g)){
      if(url.startsWith('http'))continue;
      assert(files.includes(url.split(/[?#]/)[0]),file+' link '+url);
    }
  }
});

test('produção exige HTTPS e origem sem caminho',()=>{
 assert.throws(()=>createApp({production:true,appURL:'http://example.test'}),/HTTPS/);
 assert.throws(()=>createApp({production:true,appURL:'https://example.test/sub'}),/sem caminho/);
});
