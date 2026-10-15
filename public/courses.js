(() => {'use strict';
const $=id=>document.getElementById(id), money=v=>(v/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const notice=t=>{$('notice').textContent=t};
async function api(route,method='GET',payload){
 const response=await fetch('/api'+route,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Fila-Request':'1'},body:payload?JSON.stringify(payload):undefined});
 const data=await response.json();if(response.status===401){location.href='login.html';return {}}
 if(!response.ok)throw Error(data.message||'Erro ao consultar serviço.');return data;
}
const tag=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el};
function appendPayment(container,order){
 const p=tag('div','Compra: '+order.title+' — '+money(order.amountCents)+' — '+order.status);p.className='payment';
 if(order.status==='pending'&&order.pixCode){
  p.append(tag('p','Pix copia e cola:'));
  const area=tag('textarea',order.pixCode);area.readOnly=true;p.append(area);
  const copy=tag('button','Copiar Pix');copy.className='buy';copy.onclick=async()=>{await navigator.clipboard.writeText(order.pixCode);notice('Código Pix copiado.');};p.append(copy);
  if(order.pixQRBase64){const img=document.createElement('img');img.alt='QR Code Pix da compra';img.src='data:image/png;base64,'+order.pixQRBase64;p.append(img)}
 }
 const refresh=tag('button','Atualizar status');refresh.className='buy';refresh.onclick=async()=>{try{const next=await api('/course-orders/'+order.id);p.replaceWith(document.createElement('div'));await load();notice('Situação atualizada: '+next.order.status)}catch(e){notice(e.message)}};p.append(tag('br',''),refresh);container.append(p);
}
async function load(){
 const [cat,owned,orders]=await Promise.all([api('/courses'),api('/my-courses'),api('/course-orders')]);
 $('catalog').replaceChildren();$('owned').replaceChildren();$('orders').replaceChildren();
 if(!cat.courses.length){$('catalog').append(tag('p','Ainda não há cursos publicados.'))}
 for(const c of cat.courses){
  const card=document.createElement('article');card.className='course';
  card.append(tag('h3',c.title),tag('p',c.description),tag('p',money(c.priceCents)));
  const btn=tag('button',cat.enabled?'Comprar com Pix':'Pagamento ainda não habilitado');btn.className='buy';btn.disabled=!cat.enabled;
  btn.onclick=async()=>{btn.disabled=true;try{const r=await api('/courses/buy','POST',{courseId:c.id});notice('Pix gerado. Confirme o pagamento no aplicativo do banco e depois atualize o status.');await load();}catch(e){notice(e.message)}finally{btn.disabled=false}};
  card.append(btn);$('catalog').append(card);
 }
 if(!owned.courses.length)$('owned').append(tag('p','Nenhum curso liberado.'));
 for(const c of owned.courses){const card=document.createElement('article');card.className='course';card.append(tag('h3',c.title));const btn=tag('button','Abrir conteúdo');btn.className='buy';btn.onclick=async()=>{try{const res=await fetch('/api/course-content/'+encodeURIComponent(c.id),{credentials:'same-origin'});if(!res.ok)throw Error('Acesso indisponível.');const text=await res.text();const view=tag('pre',text);view.style.whiteSpace='pre-wrap';card.append(view);btn.disabled=true}catch(e){notice(e.message)}};card.append(btn);$('owned').append(card)}
 if(!orders.orders.length)$('orders').append(tag('p','Nenhuma compra ainda.'));
 for(const o of orders.orders)appendPayment($('orders'),o);
 if(cat.courses.length)notice(cat.enabled?'Escolha um curso.':'Checkout de cursos ainda desativado.');
}
load().catch(e=>notice(e.message));
})();