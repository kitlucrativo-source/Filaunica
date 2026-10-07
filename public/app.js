(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const page = location.pathname.split('/').pop() || 'index.html';
  const params = new URLSearchParams(location.search);
  const privatePages = ['dashboard.html','perfil.html','historico.html','saque.html','pagamento.html','obrigado.html','afiliados.html','admin.html'];
  const money = cents => cents == null ? 'A definir' : (cents / 100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  let ready = false;
  const loadingControls = [...document.querySelectorAll('form input, form select, form button')];
  const initialDisabled = new Map(loadingControls.map(el => [el, el.disabled]));
  loadingControls.forEach(el => { el.disabled = true; });
  document.addEventListener('submit', e => { if (!ready) { e.preventDefault(); message('Aguarde o carregamento da página.'); } }, true);
  function message(text, error=false) {
    let box=$('app-message');
    if(!box) { box=document.createElement('div');box.id='app-message';box.setAttribute('role','status');box.setAttribute('aria-live','polite');(document.querySelector('.wrap') || document.body).prepend(box); }
    box.className='app-message'+(error?' error':'');box.textContent=text;box.scrollIntoView({block:'nearest'});
  }
  async function api(route, method='GET', data) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch('/api'+route,{method,credentials:'same-origin',signal:controller.signal,
        headers:{'Content-Type':'application/json','X-Fila-Request':'1'},body:data===undefined?undefined:JSON.stringify(data)});
      const value=await response.json();
      if(!response.ok) {const error=new Error(value.message || 'Não foi possível concluir.');error.status=response.status;throw error;}
      return value;
    }catch(error){
      if(error.status===401 && privatePages.includes(page)) location.replace('login.html');
      if(error.name==='AbortError' || error instanceof TypeError) throw new Error('Não foi possível conectar ao servidor. Tente novamente.');
      throw error;
    }finally{clearTimeout(timer);}
  }
  function bind(id, event, action) {
    const el=$(id); if(!el) return;
    el.addEventListener(event,async e=>{
      e.preventDefault();const button=el.matches('button')?el:el.querySelector('button[type=submit]');
      if(button?.disabled)return;
      if(button)button.disabled=true;
      try{await action();}catch(error){message(error.message,true);}finally{if(button)button.disabled=false;}
    });
  }
  function row(parent, values) {
    const tr=document.createElement('tr');values.forEach(v=>{const td=document.createElement('td');td.textContent=String(v??'—');tr.append(td);});parent.append(tr);return tr;
  }
  function emptyRow(id,text,cols) { const tr=row($(id),[text]);tr.firstChild.colSpan=cols; }
  function options(id, levels, value) {
    $(id).replaceChildren();
    Object.entries(levels).forEach(([key,level])=>{const o=document.createElement('option');o.value=key;o.textContent=level.nome;$(id).append(o);});
    $(id).value=Object.hasOwn(levels,value)?value:'bronze';
  }
  function rules() {
    const input=$('senha');
    input?.addEventListener('input',()=>{
      const s=input.value,r={len:s.length>=8,lower:/[a-z]/.test(s),upper:/[A-Z]/.test(s),num:/[0-9]/.test(s)};
      document.querySelectorAll('#senhaRules [data-rule]').forEach(el=>el.classList.toggle('ok',!!r[el.dataset.rule]));
    });
    $('email')?.addEventListener('input',()=>{
      const email=$('email').value,r={at:email.includes('@'),domain:/@[^\s@]+\.[^\s@]+$/.test(email),format:/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)};
      document.querySelectorAll('#emailRules [data-rule]').forEach(el=>el.classList.toggle('ok',!!r[el.dataset.rule]));
    });
  }
  function ref(user) {
    if(!$('refLink'))return;
    const url=new URL('cadastro.html',location.origin);url.searchParams.set('id',user.login);$('refLink').value=url.href;
    bind('copyBtn','click',async()=>{
      try{await navigator.clipboard.writeText(url.href);message('Link copiado.');}
      catch{$('refLink').focus();$('refLink').select();message('Selecionei o link. Use Ctrl+C ou a opção Copiar do celular.');}
    });
  }
  function navigation(user) {
    const nav=document.createElement('nav');nav.className='app-nav';nav.setAttribute('aria-label','Área da conta');
    const items=[['dashboard.html','Painel'],['perfil.html','Perfil'],['afiliados.html','Indicações'],['historico.html','Histórico e tabela'],['pagamento.html','Pagamento'],['saque.html','Saque']];
    if(user.role==='admin')items.push(['admin.html','Admin']);
    for(const [href,label]of items){const a=document.createElement('a');a.href=href;a.textContent=label;if(page===href)a.setAttribute('aria-current','page');nav.append(a);}
    const out=document.createElement('button');out.type='button';out.textContent='Sair';out.id='app-logout';nav.append(out);
    (document.querySelector('header')||document.querySelector('.service-banner')).after(nav);
    const logout=async()=>{await api('/logout','POST',{});location.replace('login.html');};
    bind('app-logout','click',logout);bind('logout','click',logout);
  }
  async function start() {
    rules();
    const config=await api('/config'),levels=config.levels;
    let user=null;
    if(privatePages.includes(page)){user=(await api('/me')).user;navigation(user);ref(user);}
    if(page==='cadastro.html'){
      let selected='bronze';
      const sponsor=params.get('id') || params.get('ref') || '';
      if(sponsor){$('sponsorName').textContent=sponsor;$('sponsorLogin').textContent='Código informado: '+sponsor;$('sponsorInitial').textContent=sponsor.slice(0,1).toUpperCase();}
      const render=()=>{
        $('levels').replaceChildren();
        for(const [key,l]of Object.entries(levels)){
          const button=document.createElement('button');button.type='button';button.className='level'+(key===selected?' active':'');button.setAttribute('aria-pressed',String(key===selected));
          button.textContent=`${l.nome} — ${money(l.valor_entrada*100)}`;
          button.addEventListener('click',()=>{selected=key;render();});$('levels').append(button);
        }
        $('summary').textContent=`Nível solicitado: ${levels[selected].nome}. Valor de referência: ${money(levels[selected].valor_entrada*100)}. Pagamento pendente de disponibilidade.`;
      };render();
      bind('signupForm','submit',async()=>{
        if($('senha').value!==$('senha2').value)throw new Error('As senhas não coincidem.');
        const fields=['login','email','nome','pais','documento','telefone','senha'];
        const data=Object.fromEntries(fields.map(key=>[key,$(key).value]));
        await api('/register','POST',{...data,nivel:selected,sponsor});location.href='pagamento.html';
      });
    }
    if(page==='login.html'){
      bind('loginForm','submit',async()=>{await api('/login','POST',{login:$('login').value,senha:$('senha').value});location.href='dashboard.html';});
    }
    if(page==='recuperar.html'){
      let resetToken=null;
      const receiveResetLink=()=>{
        const incoming=new URLSearchParams(location.hash.slice(1)).get('token');
        if(incoming){resetToken=incoming;history.replaceState(null,'',location.pathname);$('findForm').hidden=true;$('resetForm').hidden=false;$('resetForm').classList.remove('hidden');}
      };
      receiveResetLink();window.addEventListener('hashchange',receiveResetLink);
      bind('findForm','submit',async()=>{const r=await api('/recovery','POST',{login:$('login').value});message(r.message);});
      bind('resetForm','submit',async()=>{
        if(!resetToken)throw new Error('Use o link de recuperação fornecido pelo administrador.');
        if($('senha').value!==$('senha2').value)throw new Error('As senhas não coincidem.');
        const r=await api('/reset','POST',{token:resetToken,senha:$('senha').value});$('resetForm').hidden=true;message(r.message);
      });
    }
    if(page==='perfil.html'){
      for(const key of ['login','nome','email','telefone','documento','pixTipo','pixChave','titular'])$(key).value=user[key]||'';
      if(!$('pixTipo').value)$('pixTipo').value='cpf';
      bind('perfilForm','submit',async()=>{
        const data=Object.fromEntries(['nome','email','telefone','documento'].map(key=>[key,$(key).value]));
        await api('/profile','PATCH',{...data,senhaAtual:$('senhaPerfil').value});$('senhaPerfil').value='';message('Perfil salvo.');
      });
      bind('pixForm','submit',async()=>{
        await api('/pix','PATCH',{pixTipo:$('pixTipo').value,pixChave:$('pixChave').value,titular:$('titular').value,senhaAtual:$('senhaPix').value});
        $('senhaPix').value='';message('Dados Pix salvos. Isso não habilita saques nem confirma titularidade da chave.');
      });
    }
    if(page==='dashboard.html'){
      const d=await api('/dashboard');
      $('who').textContent=user.login;$('hello').textContent=`Olá, ${user.nome}. Seu cadastro está salvo; a participação aguarda pagamento.`;
      $('saldo').textContent=money(d.balanceCents);$('bonus').textContent=money(d.bonusCents);$('nivel').textContent=levels[user.nivel].nome;$('posicoes').textContent=d.positions.length;
      $('positions').textContent='Nenhuma posição ativa. Cadastro e solicitação pendente não confirmam pagamento.';
      d.orders.forEach(o=>{const p=document.createElement('p');p.textContent=`${levels[o.nivel].nome} — ${money(o.amount_cents)} — Pendente`; $('pendingOrders').append(p);});
      emptyRow('hist','Nenhum ciclo confirmado.',5);
      $('nextStep').textContent='Aguarde a disponibilização dos pagamentos. Consulte a previsão na aba Histórico e tabela.';
    }
    if(page==='afiliados.html'){
      const d=await api('/referrals');$('count').textContent=d.referrals.length;$('bonus').textContent=money(d.bonusCents);
      if(d.referrals.length){$('list').hidden=true;$('table').style.display='table';d.referrals.forEach(r=>row($('tbody'),[r.login,levels[r.nivel].nome,'Cadastro pendente de pagamento']));}
    }
    if(page==='pagamento.html'){
      const d=await api('/dashboard');const selected=Object.hasOwn(levels,params.get('nivel'))?params.get('nivel'):user.nivel;
      options('nivelPedido',levels,selected);
      $('login').textContent=user.login;$('sponsor').textContent=user.sponsor||'Sem patrocinador direto';
      const render=()=>{const l=levels[$('nivelPedido').value];$('nivel').textContent=l.nome;$('valor').textContent=money(l.valor_entrada*100);};
      $('nivelPedido').addEventListener('change',render);render();
      $('payBtn').disabled=true;
      bind('saveOrder','click',async()=>{await api('/orders','POST',{nivel:$('nivelPedido').value});message('Solicitação pendente registrada. Nenhuma cobrança foi feita.');});
      if(d.orders.length)message('Sua solicitação está salva. O Mercado Pago ainda não está habilitado.');
    }
    if(page==='obrigado.html'){
      const d=await api('/dashboard'),order=d.orders[0];
      $('protocolo').textContent=order?.id||'Nenhuma solicitação';$('nivel').textContent=levels[order?.nivel||user.nivel].nome;
      $('valor').textContent=money(order?.amount_cents??0);$('login').textContent=user.login;
    }
    if(page==='historico.html'){
      await api('/dashboard');options('nivelConsulta',levels,user.nivel);
      const render=()=>{
        const l=levels[$('nivelConsulta').value],cs=l.ciclos;
        $('nivel').textContent=l.nome;$('recebe').textContent=money(cs[0].recebido+cs[1].recebido);
        $('saque').textContent=cs.some(c=>c.saque===null)?'A definir':money(cs[0].saque+cs[1].saque);$('status').textContent='Sem ciclo confirmado';
        $('notaTabela').textContent=l.situacao+' • Previsão, não saldo disponível.'+(l.nome==='Bronze'?' A reserva de R$ 20 passa do primeiro para o segundo ciclo, sem nova receita.':'')+(l.nome==='Diamante'?' R$ 9.600 por ciclo é saldo antes das regras finais, não um saque definido.':'');
        $('ciclos').replaceChildren();cs.forEach((c,i)=>row($('ciclos'),[`${i+1}º do par`,money(c.recebido),money(c.patrocinador),money(c.reserva_anterior),money(c.reentrada),money(c.reserva),money(c.subida_de_nivel),money(c.saque),l.situacao]));
      };$('nivelConsulta').addEventListener('change',render);render();$('empty').style.display='block';
    }
    if(page==='saque.html'){
      const d=await api('/dashboard');$('available').textContent=money(d.balanceCents);$('pix').value=user.pixChave||'';
      $('form').querySelector('button').disabled=true;$('valor').disabled=true;$('pix').disabled=true;
      $('form').addEventListener('submit',e=>{e.preventDefault();message('Saques indisponíveis até a integração e existência de saldo confirmado.',true);});
    }
    if(page==='admin.html'){
      const d=await api('/admin');
      for(const u of d.users)row($('users'),[u.login,u.nome,u.email,levels[u.nivel].nome]);
      for(const o of d.orders)row($('orders'),[o.login,levels[o.nivel].nome,money(o.amount_cents),'Pendente']);
      for(const r of d.recovery)row($('recovery'),[r.login,r.email,new Date(r.requested_at).toLocaleString('pt-BR'),({pending:'Aguardando atendimento',link_created:'Link criado',completed:'Concluído'})[r.status]||r.status]);
      if(!d.recovery.length)emptyRow('recovery','Nenhuma solicitação.',4);
    }
    ready=true;
    if(page !== 'saque.html') loadingControls.forEach(el => { el.disabled = initialDisabled.get(el); });
  }
  window.addEventListener('pageshow',event=>{if(event.persisted && privatePages.includes(page))location.reload();});
  start().catch(error=>{message(error.message,true);document.querySelectorAll('form button[type=submit]').forEach(b=>b.disabled=true);});
})();
