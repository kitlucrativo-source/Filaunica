import { createApp } from '../server.js';
import { issueReset } from '../store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir=await mkdtemp(path.join(tmpdir(),'fila-browser-'));
const port=Number(process.env.BROWSER_TEST_PORT||9888),base=`http://127.0.0.1:${port}`;
const {server,db}=createApp({dataDir:dir,appURL:base,production:false});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1365,height:900}});
const page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.setDefaultTimeout(10000);
await page.route('https://fonts.googleapis.com/**',route=>route.abort());
await page.route('https://fonts.gstatic.com/**',route=>route.abort());
async function go(file){await page.goto(base+'/'+file);}
async function waitText(selector, text, value=false) {
 const el=page.locator(selector);await el.waitFor({state:'attached'});
 for(let i=0;i<100;i++){const actual=value?await el.inputValue():await el.textContent();if(actual.includes(text))return;await page.waitForTimeout(50);}
 throw new Error('Texto não apareceu: '+selector+' '+text);
}
async function register(login,ref=''){
 await go('cadastro.html'+(ref?'?id='+ref:''));
 await page.locator('#levels button').first().waitFor();
 for(const [id,value]of Object.entries({login,email:login+'@example.test',nome:'Pessoa Teste',documento:'00000000000',telefone:'11999999999',senha:'SenhaTeste123',senha2:'SenhaTeste123'}))await page.fill('#'+id,value);
 await page.click('#submitBtn');await page.waitForURL('**/pagamento.html');await waitText('#login',login);
}
try{
 await go('index.html');await page.getByRole('link',{name:'Criar minha conta',exact:true}).click();await page.waitForURL('**/cadastro.html');
 await register('ana');assert.equal(await page.locator('#payBtn').isDisabled(),true);
 await go('dashboard.html');await waitText('#who','ana');
 assert.equal(await page.textContent('#posicoes'),'0');assert.match(await page.textContent('#hist'),/Nenhum ciclo/);
 await page.getByRole('link',{name:'Perfil',exact:true}).click();await page.fill('#nome','Nome Atualizado');await page.locator('#perfilForm button').click();await waitText('#app-message','Perfil salvo.');
 await page.selectOption('#pixTipo','email');await page.fill('#pixChave','ana@example.test');await page.fill('#titular','Pessoa Teste');await page.fill('#senhaPix','SenhaTeste123');await page.locator('#pixForm button').click();await waitText('#app-message','Dados Pix salvos.');
 await page.reload();await waitText('#nome','Nome Atualizado',true);assert.equal(await page.inputValue('#pixChave'),'ana@example.test');
 await page.getByRole('link',{name:'Histórico e tabela',exact:true}).click();await page.waitForSelector('#ciclos tr');assert.match(await page.locator('#ciclos tr').first().textContent(),/30,00/);
 await page.selectOption('#nivelConsulta','diamante');assert.equal(await page.textContent('#saque'),'A definir');assert.match(await page.textContent('#notaTabela'),/9.600/);
 await page.getByRole('link',{name:'Pagamento',exact:true}).click();await page.selectOption('#nivelPedido','prata');await page.click('#saveOrder');await waitText('#app-message','Solicitação pendente registrada');
 await go('obrigado.html?status=approved');assert.equal(await page.textContent('h1'),'Solicitação pendente');
 await go('saque.html');await page.waitForSelector('#app-logout');assert.equal(await page.locator('#form button').isDisabled(),true);
 await page.click('#app-logout');await page.waitForURL('**/login.html');
 await go('dashboard.html');await page.waitForURL('**/login.html');
 await page.fill('#login','ana');await page.fill('#senha','errada');await page.locator('#loginForm button').click();await waitText('#app-message','Login ou senha inválidos.');
 await register('bia','ana');await page.click('#app-logout');await page.waitForURL('**/login.html');
 await page.fill('#login','ana');await page.fill('#senha','SenhaTeste123');await page.locator('#loginForm button').click();await page.waitForURL('**/dashboard.html');
 await go('afiliados.html');await waitText('#count','1');assert.match(await page.textContent('#tbody'),/bia/);
 await page.click('#copyBtn');await page.waitForSelector('#app-message');assert.match(await page.inputValue('#refLink'),/id=ana/);
 db.prepare("UPDATE users SET role='admin' WHERE login='ana'").run();
 await go('admin.html');await page.waitForSelector('#users tr');assert.equal(await page.locator('#users tr').count(),2);
 await page.click('#app-logout');await page.waitForURL('**/login.html');
 await page.getByRole('link',{name:'Esqueceu a senha?'}).click();await page.fill('#login','ana');await page.locator('#findForm button').click();await waitText('#app-message','administrador');
 const link=issueReset(db,'ana',base);await page.goto(link);await page.locator('#resetForm').waitFor({state:'visible'});assert.equal(new URL(page.url()).hash,'');
 await page.fill('#senha','NovaSenha123');await page.fill('#senha2','NovaSenha123');await page.locator('#resetForm button').click();await waitText('#app-message','Senha atualizada. Entre novamente.');
 await go('login.html');await page.fill('#login','ana');await page.fill('#senha','NovaSenha123');await page.locator('#loginForm button').click();await page.waitForURL('**/dashboard.html');
 await page.setViewportSize({width:390,height:844});
 for(const file of ['dashboard.html','perfil.html','historico.html','afiliados.html','pagamento.html']){
  await go(file);await page.waitForSelector('#app-logout');
  await page.waitForTimeout(100);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);
  assert.equal(overflow,false,'Overflow mobile: '+file);
 }
 await go('dashboard.html');await waitText('#who','ana');
 if(process.env.BROWSER_SCREENSHOT) await page.screenshot({path:process.env.BROWSER_SCREENSHOT,fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('OK: cliques em cadastro, login, perfil, Pix, indicação/cópia, pedidos, histórico, Diamante, saque bloqueado, recuperação, Admin, logout e cinco telas mobile. Sem erros JavaScript.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
