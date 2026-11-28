// ============ ESTADO ============
let abaAtual='quadro',currentId=null;
let todasEtiquetas=[],etiquetasSelecionadas=new Set();
let carregando=false,ultimoHash='',recarregarPendente=false;
const canal=new BroadcastChannel('scm-board-sync');

// ============ CORES ============
const COR_PADRAO='#ebecf0';
const CORES_COLUNA=[
 {cor:'#ebecf0',nome:'Padrão'},{cor:'#dbeafe',nome:'Azul claro'},{cor:'#dcfce7',nome:'Verde claro'},
 {cor:'#fef9c3',nome:'Amarelo claro'},{cor:'#fde68a',nome:'Amarelo'},{cor:'#fecaca',nome:'Vermelho claro'},
 {cor:'#e9d5ff',nome:'Roxo claro'},{cor:'#ddd6fe',nome:'Lilás'},{cor:'#bfdbfe',nome:'Azul'},{cor:'#a7f3d0',nome:'Verde'},
];
const MAP_CORES=new Map(CORES_COLUNA.map(c=>[c.cor.toLowerCase(),c.nome]));
const isPadrao=c=>!c||String(c).toLowerCase()===COR_PADRAO;
const corEfetiva=c=>isPadrao(c)?null:c;
const nomeDaCor=c=>isPadrao(c)?'Padrão':(MAP_CORES.get(String(c).toLowerCase())||c);

let cacheCores=null;
const lerCoresLocal=()=>{if(cacheCores)return cacheCores;try{cacheCores=JSON.parse(localStorage.getItem('cores_colunas')||'{}')}catch{cacheCores={}}return cacheCores};
const getCor=id=>corEfetiva(lerCoresLocal()[id])||null;
const setCorLocal=(id,cor)=>{const t=lerCoresLocal();if(corEfetiva(cor))t[id]=cor;else delete t[id];localStorage.setItem('cores_colunas',JSON.stringify(t))};

// ============ HELPERS ============
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const escAttr=s=>String(s??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
const fmtData=d=>{try{return new Date(d).toLocaleDateString('pt-BR')}catch{return''}};
const setNome=n=>{const el=$('nome-usuario');if(el)el.textContent='Olá, '+n};

async function api(url,method='GET',body=null){
  try{
    const res=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):null});
    if(method!=='GET')try{canal.postMessage('atualizou')}catch{}
    if(res.status===204)return{};
    return await res.json().catch(()=>({}));
  }catch{return{}}
}
const put=(u,b)=>api(u,'PUT',b),post=(u,b)=>api(u,'POST',b),del=u=>api(u,'DELETE');

// ============ IDENTIFICAÇÃO ============
async function verificarIdentificacao(){
  const nome=localStorage.getItem('meu_nome')||(await api('/api/me'))?.nome||'';
  if(!nome){$('modalIdentificar').style.display='flex';setTimeout(()=>$('input-nome')?.focus(),100);return}
  localStorage.setItem('meu_nome',nome);setNome(nome);
}
async function confirmarNome(){
  const nome=$('input-nome').value.trim();if(!nome)return alert('Digite seu nome');
  localStorage.setItem('meu_nome',nome);await post('/api/identify',{name:nome});
  $('modalIdentificar').style.display='none';setNome(nome);load(true);
}
function trocarNome(){$('input-nome').value=localStorage.getItem('meu_nome')||'';$('modalIdentificar').style.display='flex'}
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&$('modalIdentificar')?.style.display==='flex')confirmarNome()});

// ============ QUADRO ============
const pill=t=>`<span style="background:${t.color}22;border:1px solid ${t.color};color:${t.color};padding:1px 8px;border-radius:20px;font-size:11px;font-weight:bold;">${esc(t.name)}</span>`;
const bolinhaHTML=(p,corAtual)=>CORES_COLUNA.map(c=>`<button type="button" class="bolinha-cor${corAtual===c.cor?' selecionada':''}" style="background-color:${c.cor}" onclick="alterarCorPessoa(${p.id},'${c.cor}',this)" title="${c.nome}">${corAtual===c.cor?'✓':''}</button>`).join('');

function menuPessoaHTML(p){
  const corAtual=corEfetiva(p.color||getCor(p.id))||COR_PADRAO;
  return `<span class="menu-pessoa-wrap"><button class="btn-menu-pessoa" onclick="event.stopPropagation();toggleMenuPessoa(event,${p.id})" title="Ações da coluna">⋯</button>
  <div class="menu-pessoa" id="menu-pessoa-${p.id}">
  <button onclick="fecharMenus();renomearPessoa(${p.id},'${escAttr(p.name)}')">✏️ Renomear pessoa</button>
  <div class="menu-cores"><small>🎨 Cor da coluna</small><div class="cores-lista">${bolinhaHTML(p,corAtual)}
  <label class="bolinha-cor bolinha-cor-custom" title="Cor personalizada">🎨<input type="color" value="${corAtual}" onchange="alterarCorPessoa(${p.id},this.value,this)"></label></div>
  <div style="font-size:12px;color:#666;margin-top:4px;">Atual: <b>${esc(nomeDaCor(corAtual))}</b> <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background-color:${corAtual};border:1px solid #999;vertical-align:middle;"></span></div>
  <button class="limpar-cor" onclick="alterarCorPessoa(${p.id},'',this)">↩ Voltar cor padrão</button></div>
  <button class="perigo" onclick="fecharMenus();delPerson(${p.id})">🗑️ Remover pessoa</button></div></span>`;
}

// CORRIGIDO: nunca apaga form/modal/menu aberto, só marca pendente
async function load(forcar=false){
  if(carregando)return;
  if(document.querySelector('.form-nova-demanda')
    || $('modalBg')?.classList.contains('open')
    || document.querySelector('.menu-pessoa.aberto')
    || document.querySelector('.menu-fundo.aberto')){
    if(forcar) recarregarPendente=true;
    return;
  }
  carregando=true;
  try{
    const people=await api(`/api/board?arquivados=${abaAtual==='arquivados'}`);
    if(!Array.isArray(people))return;
    const hash=JSON.stringify(people)+abaAtual;
    if(hash===ultimoHash&&!forcar)return;
    ultimoHash=hash;
    recarregarPendente=false;
    const isArq=abaAtual==='arquivados';
    $('board').innerHTML=people.map(p=>{
      const cor=corEfetiva(p.color||getCor(p.id));
      return `<div class="person"${cor?` style="background-color:${cor}"`:''}><h2>${esc(p.name)} <span>${p.cards.length}</span> ${menuPessoaHTML(p)}</h2>${p.cards.map(c=>cardHTML(c,isArq)).join('')}${isArq?'':`<button class="add" onclick="mostrarFormNovaDemanda(this.parentElement,${p.id},this)">+ Adicionar demanda</button>`}</div>`;
    }).join('');
    if(!isArq)document.querySelectorAll('.card').forEach(el=>el.ondblclick=()=>openDetail(+el.dataset.id));
  }finally{carregando=false}
}

function cardHTML(c,isArq){
  const concluido=!!c.concluido;
  const acoes=isArq?`<button class="botao-card" onclick="event.stopPropagation();desarquivarDemanda(${c.id})" title="Desarquivar">📤</button>`
  :`<button class="botao-card" onclick="event.stopPropagation();openDetail(${c.id})" title="Modificar">✏️</button>${concluido?`<button class="botao-card" onclick="event.stopPropagation();arquivarDemanda(${c.id})" title="Arquivar">📦</button>`:''}`;
  return `<div class="card${isArq?' card-arquivado':''}${concluido?' card-concluido':''}" data-id="${c.id}">${!isArq?`<button class="bolinha-concluir ${concluido?'concluido':''}" onclick="event.stopPropagation();concluirDemanda(${c.id})">${concluido?'✓':''}</button>`:''}<div class="card-acoes">${acoes}</div><b>${esc(c.title)}</b>${c.tags?.length?`<div style="display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;">${c.tags.map(pill).join('')}</div>`:''}<p>${esc(c.obs)}</p>${c.comments_count?`<div class="comments">💬 ${c.comments_count} comentário${c.comments_count>1?'s':''}</div>`:''}</div>`;
}

// ============ PESSOAS ============
async function addPerson(){const n=prompt('Nome da pessoa:');if(n?.trim()){await post('/api/people',{name:n.trim()});load(true)}}
async function delPerson(id){if(confirm('Remover essa pessoa e todas as demandas dela?')){await del(`/api/people/${id}`);load(true)}}
function toggleMenuPessoa(e,id){e.stopPropagation();const m=$('menu-pessoa-'+id),ab=m.classList.contains('aberto');fecharMenus();if(!ab)m.classList.add('aberto')}
function fecharMenus(){
  const tinhaAberto=document.querySelector('.menu-pessoa.aberto')||document.querySelector('.menu-fundo.aberto');
  document.querySelectorAll('.menu-pessoa.aberto').forEach(m=>m.classList.remove('aberto'));
  $('menu-fundo')?.classList.remove('aberto');
  if(tinhaAberto && recarregarPendente) load(true);
}
document.addEventListener('click',e=>{if(!e.target.closest('.menu-pessoa-wrap')&&!e.target.closest('#menu-fundo')&&e.target.id!=='btn-menu-fundo')fecharMenus()});
async function renomearPessoa(id,nomeAtual){const novo=prompt('Novo nome da pessoa:',nomeAtual);if(!novo?.trim()||novo.trim()===nomeAtual)return;await put(`/api/people/${id}`,{name:novo.trim()});load(true)}
async function alterarCorPessoa(id,cor,el){
  const coluna=el.closest('.person'),efetiva=corEfetiva(cor);
  if(coluna)coluna.style.backgroundColor=efetiva||'';
  el.closest('.cores-lista')?.querySelectorAll('.bolinha-cor').forEach(b=>b.classList.remove('selecionada'));
  if(el.classList)el.classList.add('selecionada');
  setCorLocal(id,cor);await put(`/api/people/${id}`,{color:efetiva||null}).catch(()=>{});load(true);
}

// ============ NOVA DEMANDA ============
function mostrarFormNovaDemanda(coluna,personId,btnAdd){
  if(coluna.querySelector('.form-nova-demanda'))return;
  if(btnAdd)btnAdd.style.display='none';
  const form=document.createElement('div');form.className='form-nova-demanda';
  form.innerHTML=`<input placeholder="Título da demanda..." autofocus><textarea rows="2" placeholder="Observação (opcional)..."></textarea><div style="display:flex;gap:6px"><button class="btn-salvar">Salvar</button><button class="btn-cancelar">Cancelar</button></div>`;
  coluna.appendChild(form);
  const input=form.querySelector('input'),textarea=form.querySelector('textarea');input.focus();
  const fechar=()=>{form.remove();if(btnAdd)btnAdd.style.display=''; if(recarregarPendente) load(true);};
  const salvar=async()=>{const titulo=input.value.trim();if(!titulo)return alert('Digite o título da demanda');fechar();const nc=await post('/api/cards',{person_id:personId,title:titulo,obs:textarea.value.trim()});if(nc?.id)load(true)};
  form.querySelector('.btn-salvar').onclick=salvar;
  form.querySelector('.btn-cancelar').onclick=()=>{fechar();load(true)};
  input.onkeydown=e=>{if(e.key==='Enter')salvar();if(e.key==='Escape'){fechar();load(true)}};
}
async function excluirDemanda(){
  if(!currentId)return;const titulo=$('fTitle')?.value||'essa demanda';
  if(!confirm(`Tem certeza que quer EXCLUIR "${titulo}"?\n\nEssa ação não pode ser desfeita.`))return;
  if(!confirm('Confirma mesmo? Vai apagar a demanda, os comentários e o histórico.'))return;
  await del(`/api/cards/${currentId}`);closeModal();load(true);
}

// ============ ETIQUETAS ============
function toggleEtiquetas(){const aba=$('aba-etiquetas'),abrir=aba.style.display==='none';aba.style.display=abrir?'block':'none';if(abrir)carregarEtiquetas()}
async function carregarEtiquetas(){todasEtiquetas=await api('/api/tags')||[];renderEtiquetas()}
function renderEtiquetas(){
  const lista=$('lista-etiquetas');
  if(!todasEtiquetas.length){lista.innerHTML='<small style="color:#8993a4">Nenhuma etiqueta ainda. Crie a primeira abaixo.</small>';return}
  lista.innerHTML=todasEtiquetas.map(t=>{const on=etiquetasSelecionadas.has(t.id);return `<span style="display:inline-flex;align-items:center;gap:2px;background:${t.color}22;border:2px solid ${t.color};border-radius:20px;padding:2px 3px 2px 10px;${on?'':'opacity:.6;'}"><button type="button" onclick="toggleEtiqueta(${t.id})" style="background:transparent;border:none;color:${t.color};cursor:pointer;font-size:12px;font-weight:bold;padding:0;">${on?'✓ ':''}${esc(t.name)}</button><button type="button" onclick="event.stopPropagation();excluirEtiqueta(${t.id})" title="Apagar '${escAttr(t.name)}'" style="background:${t.color};color:#fff;border:none;width:16px;height:16px;border-radius:50%;cursor:pointer;font-size:12px;line-height:1;">×</button></span>`}).join('');
}
function toggleEtiqueta(id){etiquetasSelecionadas.has(id)?etiquetasSelecionadas.delete(id):etiquetasSelecionadas.add(id);renderEtiquetas()}
async function criarEtiqueta(){
  const nome=$('nova-etiqueta').value.trim();if(!nome)return alert('Digite o nome da etiqueta');
  const nova=await post('/api/tags',{name:nome,color:$('cor-etiqueta').value});
  if(nova?.id){if(!todasEtiquetas.some(t=>t.id===nova.id))todasEtiquetas.push(nova);etiquetasSelecionadas.add(nova.id);$('nova-etiqueta').value='';renderEtiquetas()}
}
async function excluirEtiqueta(id){
  const tag=todasEtiquetas.find(t=>t.id===id);
  if(!tag||!confirm(`Apagar a etiqueta "${tag.name}"?\nEla vai sumir de todas as demandas.`))return;
  await del(`/api/tags/${id}`);todasEtiquetas=todasEtiquetas.filter(t=>t.id!==id);etiquetasSelecionadas.delete(id);renderEtiquetas();load(true);
}

// ============ DETALHE ============
async function openDetail(id){
  currentId=id;const c=await api(`/api/cards/${id}`);if(!c)return;
  if(c.arquivado){if(confirm(`"${c.title}" está arquivada.\nQuer desarquivar ela pra poder editar?`))await desarquivarDemanda(id);return}
  $('fTitle').value=c.title||'';$('fObs').value=c.obs||'';$('fResp').value=c.responsavel||'';
  $('fPrazo').value=c.prazo?c.prazo.slice(0,10):'';$('fPrio').value=c.prioridade||'Média';$('fDesc').value=c.description||'';
  etiquetasSelecionadas=new Set((c.tags||[]).map(t=>t.id));$('aba-etiquetas').style.display='none';
  $('fSit').value=c.tags?.length?c.tags.map(t=>t.name).join(', '):(c.situacao||'');
  $('commentList').innerHTML=c.comments?.length?c.comments.map(cm=>`<div class="comment">${esc(cm.text)}<small>${esc(cm.user_name)} • ${fmtData(cm.created_at)}</small></div>`).join(''):'<p style="color:#8993a4;font-size:13px">Sem comentários</p>';
  $('history').innerHTML=(c.history||[]).map(h=>`${esc(h.action)} - ${new Date(h.created_at).toLocaleString('pt-BR')}`).join('<br>');
  $('history').style.display='none';$('btn-historico').textContent=`🕒 Ver histórico (${(c.history||[]).length}) ▾`;
  $('modalBg').classList.add('open');
}
function closeModal(){$('modalBg').classList.remove('open'); if(recarregarPendente) load(true);}
function toggleHistorico(){const h=$('history'),b=$('btn-historico'),ab=h.style.display!=='none';h.style.display=ab?'none':'block';b.textContent=ab?b.textContent.replace('Ocultar','Ver').replace('▴','▾'):b.textContent.replace('Ver','Ocultar').replace('▾','▴')}
async function addComment(){
  const inp=$('newComment');if(!inp.value.trim())return;
  await post(`/api/cards/${currentId}/comments`,{text:inp.value.trim()});inp.value='';openDetail(currentId);load(true);
}
async function saveDetail(){
  await put(`/api/cards/${currentId}`,{title:$('fTitle').value,obs:$('fObs').value,responsavel:$('fResp').value,prazo:$('fPrazo').value,situacao:$('fSit').value,prioridade:$('fPrio').value,description:$('fDesc').value});
  await put(`/api/cards/${currentId}/tags`,{tag_ids:[...etiquetasSelecionadas]});closeModal();load(true);
}
async function acaoCard(id,acao){await put(`/api/cards/${id}/${acao}`);load(true)}
const concluirDemanda=id=>acaoCard(id,'concluir'),arquivarDemanda=id=>acaoCard(id,'arquivar'),desarquivarDemanda=id=>acaoCard(id,'desarquivar');

function mostrarAba(qual){
  abaAtual=qual;const isArq=qual==='arquivados';
  $('aba-quadro')?.classList.toggle('ativa',!isArq);$('aba-arquivados')?.classList.toggle('ativa',isArq);
  document.body.classList.toggle('modo-arquivados',isArq);$('banner-arquivados').style.display=isArq?'block':'none';
  ultimoHash='';load(true);
}
function ligarAbas(){
  $('aba-quadro').onclick=e=>{e.preventDefault();mostrarAba('quadro')};
  $('aba-arquivados').onclick=e=>{e.preventDefault();mostrarAba('arquivados')};
}

// ============ FUNDO ============
const lerFundo=()=>{try{return JSON.parse(localStorage.getItem('fundo_quadro')||'{}')}catch{return{}}};
const salvarFundo=(tipo,valor)=>{
  const atual=lerFundo(),novo={tipo,valor,escurecer:atual.escurecer??(tipo==='imagem')};
  try{localStorage.setItem('fundo_quadro',JSON.stringify(novo))}catch{return alert('Imagem muito pesada pro navegador salvar. Escolhe uma menor.')}
  aplicarFundo();
};
function aplicarFundo(){
  const s=lerFundo(),b=document.body;
  b.style.background='';b.style.backgroundColor='';b.style.backgroundImage='';
  b.classList.remove('fundo-imagem','fundo-escurecido');
  if(s.tipo==='cor')b.style.backgroundColor=s.valor;
  else if(s.tipo==='gradiente')b.style.background=s.valor;
  else if(s.tipo==='imagem'&&s.valor){b.style.backgroundImage=`url(${s.valor})`;b.style.backgroundSize='cover';b.style.backgroundPosition='center';b.style.backgroundAttachment='fixed';b.classList.add('fundo-imagem')}
  if(s.escurecer)b.classList.add('fundo-escurecido');
  const ch=$('check-escurecer');if(ch)ch.checked=!!s.escurecer;
}
const setFundoCor=c=>salvarFundo('cor',c),setFundoGradiente=g=>salvarFundo('gradiente',g);
function limparFundo(){localStorage.removeItem('fundo_quadro');aplicarFundo()}
function toggleEscurecer(on){const s=lerFundo();s.escurecer=on;localStorage.setItem('fundo_quadro',JSON.stringify(s));aplicarFundo()}
function setFundoImagem(input){
  const f=input.files?.[0];if(!f)return;if(!f.type.startsWith('image/'))return alert('Escolhe um arquivo de imagem.');
  const r=new FileReader();r.onload=e=>{const img=new Image();img.onload=()=>{const cv=document.createElement('canvas'),max=1600,esc2=Math.min(1,max/Math.max(img.width,img.height));cv.width=Math.round(img.width*esc2);cv.height=Math.round(img.height*esc2);cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);salvarFundo('imagem',cv.toDataURL('image/jpeg',0.8))};img.src=e.target.result};r.readAsDataURL(f);input.value='';
}
function toggleMenuFundo(e){e.stopPropagation();$('menu-fundo')?.classList.toggle('aberto');document.querySelectorAll('.menu-pessoa.aberto').forEach(m=>m.classList.remove('aberto'))}

// ============ INICIO + SYNC ENTRE ABAS ============
document.addEventListener('DOMContentLoaded',()=>{ligarAbas();verificarIdentificacao();aplicarFundo();load(true)});
canal.onmessage=e=>{if(e.data==='atualizou')load(true)};
window.addEventListener('focus',()=>load(true));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load(true)});
setInterval(()=>{
  if(!document.querySelector('.form-nova-demanda')
    && !$('modalBg')?.classList.contains('open')
    && !document.querySelector('.menu-pessoa.aberto')
    && !document.querySelector('.menu-fundo.aberto')) load(true);
},5000);