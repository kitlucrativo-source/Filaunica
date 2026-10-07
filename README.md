# Fila Única — pacote para publicar cadastro e área de membros

Esta versão substitui o demonstrativo do navegador por uma aplicação com servidor e banco persistente. Mantém o visual preto e dourado e usa os valores da planilha fornecida. **Não foi publicada por esta entrega.**

## O que está funcionando

- Cadastro de várias contas, login por usuário ou e-mail e saída.
- Senhas com salt e scrypt; sessões no servidor, com cookie HttpOnly.
- Dados pessoais e Pix salvos no banco. Alterar e-mail ou Pix exige senha atual.
- Link de indicação e lista dos cadastros realmente indicados, isolados por conta.
- Solicitações de participação pendentes, com preço definido pelo servidor.
- Painel e histórico sem posições, ciclos ou saldos inventados.
- Previsão dos oito níveis conforme a planilha; reserva Bronze de R$ 20 transportada ao segundo ciclo.
- Safira, Esmeralda e Rubi marcados como projeção; Diamante com bônus e saque a definir.
- Administração restrita a contas autorizadas no servidor: consulta de usuários, solicitações e recuperação de conta.
- Recuperação de senha por atendimento, com link aleatório, de uso único, válido por 30 minutos. Trocar a senha encerra as sessões anteriores.

## O que fica pendente

**Mercado Pago ainda não foi integrado, conforme sua decisão de configurar depois.** Não há cobrança, Pix gerado, confirmação de pagamento, saldo financeiro, saque, posição ativa, reentrada ou upgrade automático em operação. Essas funções estão bloqueadas tanto na tela quanto no servidor.

A etapa financeira exigirá implementação e testes da integração, confirmação autenticada de eventos, conciliação, registros contábeis, tratamento de estornos e execução das regras. **Não basta inserir uma chave para liberar dinheiro nesta versão.**

O envio automático de e-mail para recuperação também não foi configurado. Por enquanto, use o atendimento administrativo explicado abaixo. Não existe verificação automática de e-mail, identidade ou titularidade de Pix.

Este pacote pode ser publicado como **cadastro e área de membros com pagamentos indisponíveis**. Não representa uma operação financeira pronta.

## Abrir no Windows

1. Instale Node.js da linha **24**, versão **24.14 ou superior**: https://nodejs.org/
2. Extraia o ZIP inteiro em uma pasta nova.
3. Dê dois cliques em **INICIAR-WINDOWS.cmd**. Mantenha essa janela aberta.
4. No navegador, abra **http://localhost:3000**.
5. Crie sua conta. Os dados passarão a ser salvos em `data/filadavez.sqlite`.

Alternativa pelo terminal na pasta do projeto:

```sh
npm start
```

Não há dependências externas de execução para instalar. Não abra os HTML diretamente, nem publique só a pasta public: o login e o banco dependem do servidor.

Se a porta 3000 estiver ocupada, encerre o servidor antigo. Para usar outra, ajuste **PORT e APP_URL** no arquivo `.env`, mantendo as duas configurações compatíveis.

As contas locais dos ZIPs anteriores não são importadas automaticamente. Esses dados antigos não são comprovação de pagamentos ou saldos. O pacote recebido não continha um banco central para migrar. Cadastre uma conta nesta versão.

## Sua conta administrativa

Cadastre sua conta pelo site. Depois, no terminal da pasta do projeto:

```sh
npm run admin -- tornar-admin seu-email@exemplo.com
```

Use seu e-mail verdadeiro no comando. Entre na conta; o link **Admin** aparecerá no menu. Nenhuma senha de administrador padrão foi criada. Apenas quem tem acesso ao servidor pode promover contas.

## Recuperação de senha

1. O usuário preenche “Esqueceu a senha?”. A solicitação aparece no Admin.
2. Você verifica a identidade por um canal já conhecido do titular. Saber o login ou pedir pelo chat não comprova identidade.
3. No terminal do servidor, gere o link:

```sh
npm run admin -- reset-link email-cadastrado@exemplo.com
```

4. Entregue o link somente ao titular verificado. Ele vale por 30 minutos, funciona uma vez e não deve ser publicado.
5. O usuário abre o link e define uma nova senha. As sessões anteriores são encerradas.

Essa etapa é manual nesta entrega: a tela não diz que um e-mail foi enviado.

## Publicar em hospedagem Node.js

É necessário um servidor Node.js 24 ou um container Docker, HTTPS e **disco persistente**. Hospedagem somente de arquivos estáticos não executa esta aplicação.

Configuração de produção:

```dotenv
NODE_ENV=production
PORT=3000
APP_URL=https://seu-dominio.com
DATA_DIR=/caminho/privado/persistente/fila
```

- APP_URL deve conter somente a origem pública, sem subpasta. Use exatamente o domínio por onde os usuários vão acessar.
- Inicie com `npm start` ou `node server.js`.
- Configure o domínio e o HTTPS no provedor/reverse proxy, apontando para a porta do app.
- Monte DATA_DIR em disco persistente e mantenha **uma instância** deste serviço. Este pacote usa SQLite local, não banco distribuído.
- Não coloque DATA_DIR, `.env` ou backups dentro de `public`.
- Não exponha a porta interna diretamente à internet; acesse pelo proxy HTTPS.
- A aplicação valida a origem das alterações. Se login/cadastro mostrarem erro de origem, confira APP_URL.
- A limitação por IP considera o endereço de conexão, sem confiar em cabeçalhos fornecidos pelo cliente. Atrás de um único proxy, visitantes podem compartilhar esse limite; ajuste a camada de proxy e a política de limitação antes de ampliar o tráfego.

### Docker

Incluídos Dockerfile e compose.yaml. Defina APP_URL no `.env` da pasta para a URL HTTPS final e execute:

```sh
docker compose up -d --build
```

O compose cria um volume persistente e expõe a aplicação apenas em `127.0.0.1:3000`. Um proxy HTTPS no host deve encaminhar o domínio para esse endereço. O HTTPS e o domínio não são criados por este comando.

Comandos administrativos no container:

```sh
docker compose exec app node admin.js tornar-admin seu-email@exemplo.com
docker compose exec app node admin.js reset-link email-cadastrado@exemplo.com
```

## Backup

Em instalação Node.js:

```sh
npm run admin -- backup /caminho/privado/backup-fila.sqlite
```

No Windows, pode usar um caminho como `C:\Backups\fila-2026-10-06.sqlite`. A pasta de destino deve existir e o arquivo não pode existir ainda. O backup inclui dados pessoais e deve ser guardado de forma privada, preferencialmente também fora do servidor.

Para restauração, pare o serviço e preserve uma cópia completa da pasta de dados antes de substituir o banco. Restaure o backup em uma pasta de dados nova como `filadavez.sqlite` e aponte DATA_DIR para ela. Isso evita misturar arquivos WAL antigos com o banco restaurado.

## Testes

```sh
npm test
```

Também foram executados testes de cliques em Chromium, incluindo cadastro, login, perfil, Pix, recuperação, indicação, pedidos, saída e telas mobile (390 px). Não houve erros JavaScript. O container Docker e a hospedagem externa não foram executados neste ambiente.

Para repetir o teste de navegador, instale o Playwright apenas no ambiente de desenvolvimento:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

Os testes usam bancos temporários e não alteram as contas reais. A checagem HTTP abre uma porta local; em ambientes restritos que recusam loopback, ela é marcada como ignorada, não como aprovada. Execute `npm test` em seu Node.js local para rodar também esse fluxo. Verificam cadastro, login, persistência, isolamento, recuperação, bloqueios financeiros, proteção de origem, acesso administrativo, tabela e referências das páginas.

## Organização

- `public/`: páginas, estilos e interface.
- `server.js`: servidor HTTP e API.
- `store.js`: banco, senhas e sessões.
- `tabela.json`: valores da planilha em centavos; campos indefinidos são null.
- `admin.js`: promoção administrativa, recuperação e backup.
- `tests/`: testes automatizados.
- `data/`: criado quando o servidor inicia; não distribuído no ZIP.

As regras da planilha são exibidas como previsão e não constituem promessa de recebimento. Não há transferência financeira nesta versão.
