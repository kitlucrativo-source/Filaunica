import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ROOT, TABLE, openStore, hash, token, passwordHash, passwordMatches, validPassword, publicUser, transaction } from './store.js';

export function createApp(options = {}) {
  const prod = options.production ?? process.env.NODE_ENV === 'production';
  const base = new URL(options.appURL || process.env.APP_URL || 'http://localhost:3000');
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password || (prod && base.protocol !== 'https:')) {
    throw new Error('APP_URL deve ser a origem do site, sem caminho. Em produção, use HTTPS.');
  }
  const origin = base.origin;
  const db = openStore(options.dataDir);
  const sessionMs = 7 * 24 * 60 * 60 * 1000;
  const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
  const audit = (id, action) => db.prepare('INSERT INTO audit(user_id,action,created_at) VALUES(?,?,?)').run(id, action, Date.now());
  const dummyPassword = passwordHash(token());
  let cryptoJobs = 0;
  async function withCrypto(fn) {
    if (cryptoJobs >= 4) fail(503, 'Muitas solicitações. Tente novamente em alguns segundos.');
    cryptoJobs++;
    try { return await fn(); } finally { cryptoJobs--; }
  }
  function limit(key, max, duration = 15 * 60 * 1000) {
    const now = Date.now(); const k = hash(key);
    db.prepare('DELETE FROM limits WHERE expires_at<?').run(now);
    db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(k, now + duration);
    if (db.prepare('SELECT count FROM limits WHERE key=?').get(k).count > max) fail(429, 'Muitas tentativas. Aguarde 15 minutos.');
  }
  function clean(value, max = 200) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value)) fail(400, 'Dados inválidos. Confira os campos.');
    return value.trim();
  }
  function email(value) { const e = clean(value, 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Informe um e-mail válido.'); return e; }
  function name(value) { const n = clean(value, 120); if (n.length < 2) fail(400, 'Informe seu nome.'); return n; }
  function password(value) { if (!validPassword(value)) fail(400, 'Senha: 8 a 128 caracteres, com maiúscula, minúscula e número.'); return value; }
  function level(value) { if (!Object.hasOwn(TABLE, value)) fail(400, 'Nível inválido.'); return value; }
  function sessionCookie(value, maxAge = sessionMs / 1000) {
    return `fila_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${prod ? '; Secure' : ''}`;
  }
  function session(req) {
    const value = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('fila_session='))?.slice(13);
    if (!value || !/^[a-f0-9]{64}$/.test(value)) fail(401, 'Entre na sua conta para continuar.');
    const row = db.prepare('SELECT u.*, s.digest AS session_digest FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=? AND s.expires_at>?').get(hash(value), Date.now());
    if (!row) fail(401, 'Sua sessão expirou. Entre novamente.');
    return row;
  }
  function newSession(res, userID) {
    const value = token();
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(value), userID, Date.now() + sessionMs);
    res.setHeader('Set-Cookie', sessionCookie(value));
  }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Envie JSON.');
    let text = ''; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16384) fail(413, 'Dados muito grandes.'); text += chunk; }
    let value; try { value = JSON.parse(text); } catch { fail(400, 'JSON inválido.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Dados inválidos.');
    return value;
  }
  function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  async function handleAPI(req, res, url) {
    const method = req.method, route = url.pathname;
    res.setHeader('Cache-Control', 'no-store');
    const ip = req.socket.remoteAddress || 'unknown'; // Não confiar em cabeçalhos de IP enviados pelo cliente.
    if (!['GET','HEAD'].includes(method)) {
      if (req.headers.origin !== origin || req.headers['x-fila-request'] !== '1') fail(403, 'Origem da solicitação não autorizada.');
      limit(`write:${ip}`, 200);
    }
    if (method === 'GET' && route === '/api/config') return send(res, 200, { levels: TABLE, paymentsEnabled: false, withdrawalsEnabled: false, recoveryMode: 'manual', minimumWithdrawalCents: 3000 });
    if (method === 'POST' && route === '/api/register') {
      limit(`register:${ip}`, 15);
      const b = await body(req); const login = clean(b.login, 32).toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(login)) fail(400, 'Login: 3 a 32 letras, números ou _.');
      const mail = email(b.email), nome = name(b.nome), senha = password(b.senha), nivel = level(b.nivel);
      const pais = clean(b.pais, 8), documento = clean(b.documento, 30), telefone = clean(b.telefone, 30);
      if (!['BR','PT','US','AR','PY','UY','OUTRO'].includes(pais) || documento.length < 5 || telefone.replace(/\D/g,'').length < 8) fail(400,'Confira país, documento e telefone.');
      let sponsor = null;
      if (b.sponsor) { sponsor = db.prepare('SELECT id FROM users WHERE login=?').get(clean(b.sponsor,32).toLowerCase()); if (!sponsor) fail(400,'Código de indicação não encontrado.'); }
      if (db.prepare('SELECT id FROM users WHERE login=? OR email=?').get(login, mail)) fail(409, 'Login ou e-mail já cadastrado.');
      const stored = await withCrypto(() => passwordHash(senha)); const id = randomUUID();
      transaction(db, () => {
        db.prepare('INSERT INTO users(id,login,email,password,nome,pais,documento,telefone,nivel,sponsor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,login,mail,stored,nome,pais,documento,telefone,nivel,sponsor?.id || null,Date.now());
        db.prepare("INSERT INTO orders VALUES(?,?,?,?,'pending',?)").run(randomUUID(),id,nivel,TABLE[nivel].valor_entrada*100,Date.now());
        audit(id,'registered');
      });
      newSession(res,id);
      return send(res,201,{ user: publicUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
    }
    if (method === 'POST' && route === '/api/login') {
      limit(`login-ip:${ip}`,40);
      const b = await body(req), identity = clean(b.login,254).toLowerCase();
      limit(`login-account:${identity}`,15);
      const supplied = clean(b.senha,128); // A senha original nunca é aparada para comparação.
      if (typeof b.senha !== 'string' || !supplied) fail(401,'Login ou senha inválidos.');
      const u = db.prepare('SELECT * FROM users WHERE login=? OR email=?').get(identity, identity);
      const match = await withCrypto(async () => passwordMatches(b.senha, u?.password || await dummyPassword));
      if (!u || !match || db.prepare('SELECT password FROM users WHERE id=?').get(u.id)?.password !== u.password) fail(401, 'Login ou senha inválidos.');
      db.prepare('DELETE FROM limits WHERE key=?').run(hash(`login-account:${identity}`));
      newSession(res,u.id); audit(u.id,'login'); return send(res,200,{user:publicUser(db,u)});
    }
    if (method === 'POST' && route === '/api/recovery') {
      limit(`recovery:${ip}`,10);
      const b=await body(req), identity=clean(b.login,254).toLowerCase();
      const u=db.prepare('SELECT id FROM users WHERE login=? OR email=?').get(identity,identity);
      if(u) db.prepare("INSERT INTO recovery_requests VALUES(?,?,'pending') ON CONFLICT(user_id) DO UPDATE SET requested_at=excluded.requested_at,status='pending'").run(u.id,Date.now());
      return send(res,202,{message:'Se a conta existir, sua solicitação ficará disponível para o administrador. O envio automático de e-mail ainda não está habilitado; solicite atendimento para receber um link após a verificação da conta.'});
    }
    if (method === 'POST' && route === '/api/reset') {
      limit(`reset:${ip}`,15);
      const b=await body(req), value=clean(b.token,64); password(b.senha);
      const r=db.prepare('SELECT * FROM resets WHERE digest=? AND expires_at>?').get(hash(value),Date.now());
      if(!r) fail(400,'Link inválido, expirado ou já utilizado.');
      const stored=await withCrypto(()=>passwordHash(b.senha));
      transaction(db,()=>{
        const valid=db.prepare('DELETE FROM resets WHERE digest=? AND expires_at>?').run(hash(value),Date.now());
        if(!valid.changes) fail(400,'Link inválido, expirado ou já utilizado.');
        db.prepare('UPDATE users SET password=? WHERE id=?').run(stored,r.user_id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id);
        db.prepare("UPDATE recovery_requests SET status='completed' WHERE user_id=?").run(r.user_id);
        audit(r.user_id,'password_reset');
      });
      res.setHeader('Set-Cookie',sessionCookie('',0));return send(res,200,{message:'Senha atualizada. Entre novamente.'});
    }
    const u = session(req);
    if (method === 'GET' && route === '/api/me') return send(res,200,{user:publicUser(db,u)});
    if (method === 'POST' && route === '/api/logout') {
      await body(req); db.prepare('DELETE FROM sessions WHERE digest=?').run(u.session_digest);
      res.setHeader('Set-Cookie',sessionCookie('',0));return send(res,200,{ok:true});
    }
    if (method === 'PATCH' && route === '/api/profile') {
      const b=await body(req), mail=email(b.email);
      if (mail !== u.email) {
        limit(`reauth:${u.id}`,10);
        if(typeof b.senhaAtual !== 'string' || b.senhaAtual.length>128 || !await withCrypto(()=>passwordMatches(b.senhaAtual,u.password))) fail(400,'Informe a senha atual para alterar seu e-mail.');
      }
      const nome=name(b.nome), phone=clean(b.telefone,30), doc=clean(b.documento,30);
      if(doc.length<5 || phone.replace(/\D/g,'').length<8) fail(400,'Confira documento e telefone.');
      db.prepare('UPDATE users SET nome=?,email=?,telefone=?,documento=? WHERE id=?').run(nome,mail,phone,doc,u.id);audit(u.id,'profile_updated');
      return send(res,200,{user:publicUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(u.id))});
    }
    if (method === 'PATCH' && route === '/api/pix') {
      limit(`reauth:${u.id}`,10);const b=await body(req);
      if(typeof b.senhaAtual !== 'string' || b.senhaAtual.length>128 || !await withCrypto(()=>passwordMatches(b.senhaAtual,u.password))) fail(400,'Senha atual incorreta.');
      const tipo=clean(b.pixTipo,15), chave=clean(b.pixChave,254), titular=name(b.titular);
      const valid = tipo==='email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(chave) : tipo==='cpf' ? /^\d{11}$/.test(chave.replace(/\D/g,'')) : tipo==='celular' ? /^\+?[\d ()-]{10,20}$/.test(chave) : tipo==='aleatoria' && /^[a-f0-9-]{36}$/i.test(chave);
      if(!valid) fail(400,'Confira o tipo e o formato da chave Pix.');
      db.prepare('UPDATE users SET pix_tipo=?,pix_chave=?,titular=? WHERE id=?').run(tipo,chave,titular,u.id);audit(u.id,'pix_updated');
      return send(res,200,{user:publicUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(u.id))});
    }
    if (method === 'GET' && route === '/api/dashboard') return send(res,200,{
      user:publicUser(db,u), orders:db.prepare('SELECT id,nivel,amount_cents,status,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC').all(u.id),
      balanceCents:0, bonusCents:0, positions:[], cycles:[], movements:[], withdrawals:[]
    });
    if(method==='GET' && route==='/api/referrals') return send(res,200,{referrals:db.prepare("SELECT login,nivel,'pending' AS status,created_at FROM users WHERE sponsor_id=? ORDER BY created_at DESC").all(u.id),bonusCents:0});
    if(method==='POST' && route==='/api/orders') {
      const b=await body(req), nivel=level(b.nivel);
      db.prepare("INSERT INTO orders VALUES(?,?,?,?,'pending',?) ON CONFLICT(user_id,nivel) DO NOTHING").run(randomUUID(),u.id,nivel,TABLE[nivel].valor_entrada*100,Date.now());
      return send(res,200,{order:db.prepare('SELECT id,nivel,amount_cents,status,created_at FROM orders WHERE user_id=? AND nivel=?').get(u.id,nivel)});
    }
    // Não aceitar comprovante, valor, status ou saldo fornecidos pelo navegador como confirmação.
    if(method==='POST' && route==='/api/checkout') { await body(req);fail(503,'Pagamentos ainda não disponíveis. A integração com o Mercado Pago será configurada depois.'); }
    if(method==='POST' && route==='/api/withdrawals') { await body(req);fail(503,'Saques indisponíveis: não há saldo confirmado nem integração de pagamentos ativa.'); }
    if(method==='GET' && route==='/api/admin') {
      if(u.role!=='admin') fail(403,'Acesso restrito ao administrador.');
      return send(res,200,{
        users:db.prepare('SELECT login,email,nome,nivel,created_at FROM users ORDER BY created_at DESC').all(),
        orders:db.prepare('SELECT o.id,u.login,o.nivel,o.amount_cents,o.status,o.created_at FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC').all(),
        recovery:db.prepare('SELECT u.login,u.email,r.requested_at,r.status FROM recovery_requests r JOIN users u ON u.id=r.user_id ORDER BY r.requested_at DESC').all()
      });
    }
    fail(404,'Recurso não encontrado.');
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if(prod) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try{
      const url=new URL(req.url,origin);
      if(url.pathname==='/healthz') return send(res,200,{status:'ok',payments:'not_configured'});
      if(url.pathname.startsWith('/api/')) return await handleAPI(req,res,url);
      if(!['GET','HEAD'].includes(req.method)) fail(405,'Método não permitido.');
      const name=decodeURIComponent(url.pathname)==='/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      if(!/^[a-zA-Z0-9_-]+\.(html|css|js|ico)$/.test(name)) fail(404,'Página não encontrada.');
      const filename=path.join(ROOT,'public',name); const info=await stat(filename);
      if(!info.isFile()) fail(404,'Página não encontrada.');
      const content=await readFile(filename);
      const type={'.html':'text/html','.css':'text/css','.js':'text/javascript','.ico':'image/x-icon'}[path.extname(name)];
      res.setHeader('Cache-Control','no-store');res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(req.method==='HEAD'?undefined:content);
    }catch(error){
      const duplicate=String(error.message).includes('UNIQUE constraint failed');
      const status=error.status || (duplicate?409:error.code==='ENOENT'?404:error instanceof URIError?400:500);
      if(status===500) console.error('Erro interno:',error.code || error.name);
      if(!res.headersSent) send(res,status,{message:duplicate?'Login ou e-mail já cadastrado.':status===500?'Erro interno. Tente novamente.':status===404?'Recurso não encontrado.':error.message});
      else res.end();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.on('close',()=>db.close());
  return {server,db};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server}=createApp();const port=Number(process.env.PORT || 3000);
  server.listen(port,'0.0.0.0',()=>console.log(`Fila Única disponível na porta ${port}. Pagamentos desativados.`));
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>server.close(()=>process.exit(0)));
}
