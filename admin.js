import { openStore, issueReset, ROOT } from './store.js';
import { backup } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
const [command, value] = process.argv.slice(2);
const db = openStore();
try {
  if(command==='tornar-admin') {
    if(!value) throw new Error('Informe o e-mail da conta que você já cadastrou.');
    const result=db.prepare("UPDATE users SET role='admin' WHERE email=?").run(value.toLowerCase());
    if(!result.changes)throw new Error('Conta não encontrada. Cadastre a conta pelo site antes.');
    console.log('Conta definida como administradora. Acesse admin.html após entrar.');
  } else if(command==='reset-link') {
    if(!value)throw new Error('Informe o login ou e-mail da conta após verificar sua identidade.');
    const origin=new URL(process.env.APP_URL || 'http://localhost:3000').origin;
    console.log('Link de uso único, válido por 30 minutos. Entregue apenas ao titular verificado:');
    console.log(issueReset(db,value,origin));
  } else if(command==='backup') {
    if(!value)throw new Error('Informe um caminho novo para o backup.');
    const target=path.resolve(value);
    if(existsSync(target))throw new Error('O destino já existe. Use outro nome para preservar seu backup.');
    await backup(db,target);console.log('Backup concluído. Guarde este arquivo em local privado.');
  } else {
    console.log('Comandos: npm run admin -- tornar-admin email | reset-link email | backup caminho.sqlite');
    process.exitCode=1;
  }
}catch(error){console.error(error.message);process.exitCode=1;}finally{db.close();}
