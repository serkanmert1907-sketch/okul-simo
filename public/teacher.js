const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const roomKey = 'simo.classroom.room.v1';
const titleKey = 'simo.classroom.title.v1';

let room = localStorage.getItem(roomKey) || '';
let socket = null;
let reconnectTimer = null;
let questionType = 'quiz';
let currentQuestion = null;
let students = [];
let reactions = { understood:0, repeat:0, slower:0, example:0 };
let activity = [];
let selectedStudentId = null;
let workspace = { enabled:false, controllerStudentId:null, title:'Ortak Çalışma', prompt:'', strokes:[], note:'', revision:0 };
let answerLog = new Map();
let chartEvents = [];
let drawState = null;

const optionDefaults = ['A seçeneği','B seçeneği','C seçeneği','D seçeneği'];

function toast(text, ms=2400){
  const el=$('#toast'); el.textContent=text; el.classList.remove('hidden');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.add('hidden'),ms);
}
function roomCode(){ return String(Math.floor(100000+Math.random()*900000)); }
function wsURL(){
  const proto=location.protocol==='https:'?'wss:':'ws:';
  return `${proto}//${location.host}/ws?room=${encodeURIComponent(room)}&role=teacher`;
}
function studentURL(){
  const u=new URL('/student.html',location.origin); u.searchParams.set('room',room); return u.toString();
}
function send(data){
  if(socket?.readyState===WebSocket.OPEN){ socket.send(JSON.stringify(data)); return true; }
  toast('Canlı bağlantı hazır değil'); return false;
}
function timeText(ts){
  if(!ts) return ''; const d=new Date(ts); return d.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'});
}
function escapeHTML(s=''){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

function setConnection(state){
  const text=$('#connectionText'),dot=$('#liveDot');
  const map={idle:'Hazır',connecting:'Bağlanıyor',online:'Canlı',offline:'Yeniden bağlanıyor'};
  text.textContent=map[state]||state; dot.classList.toggle('live',state==='online');
}

function startSession(){
  if(!room){ room=roomCode(); localStorage.setItem(roomKey,room); }
  renderRoom(); connect(); toast(`Oda ${room} açıldı`);
}
function renderRoom(){
  $('#roomCode').textContent=room||'------';
  $('#barRoom').textContent=room?`Oda ${room}`:'Oda kapalı';
  $('#startSession').textContent=room?'● Oda Açık':'▶ Oturumu Başlat';
}
async function copyJoin(){
  if(!room) startSession();
  try{await navigator.clipboard.writeText(studentURL());toast('Öğrenci linki kopyalandı');}
  catch{toast(studentURL(),4200)}
}
function connect(){
  if(!room) return;
  clearTimeout(reconnectTimer);
  if(socket && [WebSocket.OPEN,WebSocket.CONNECTING].includes(socket.readyState)) return;
  setConnection('connecting');
  socket=new WebSocket(wsURL());
  socket.onopen=()=>{ setConnection('online'); send({type:'set_title',title:localStorage.getItem(titleKey)||'Canlı Ders'}); };
  socket.onmessage=e=>{try{handleMessage(JSON.parse(e.data));}catch{}};
  socket.onerror=()=>setConnection('offline');
  socket.onclose=()=>{setConnection('offline');reconnectTimer=setTimeout(connect,1800)};
}

function handleMessage(data){
  if(data.type==='sync_request'){send({type:'teacher_sync',workspace});return;}
  if(data.type==='snapshot'){
    currentQuestion=data.currentQuestion||null; students=data.students||[]; reactions=data.reactions||reactions;
    selectedStudentId=data.selectedStudentId||null; workspace=data.workspace||workspace; activity=data.activity||[];
    if(data.classTitle){$('#topClassTitle').textContent=data.classTitle;}
    answerLog.clear(); students.forEach(s=>{if(s.lastAnswer!=null)answerLog.set(s.id,{value:s.lastAnswer,correct:s.lastAnswerCorrect})});
    renderAll(); return;
  }
  if(data.type==='presence'){students=data.students||[];renderStudents();renderMetrics();return;}
  if(data.type==='question'){currentQuestion=data.question||null;answerLog.clear();renderQuestionStatus();renderMetrics();renderChart();return;}
  if(data.type==='answer'){
    answerLog.set(data.studentId,{value:data.value,correct:data.correct});
    chartEvents.push({at:Date.now(),kind:'answer',correct:data.correct}); if(chartEvents.length>20)chartEvents.shift();
    renderMetrics();renderChart();renderStudents();return;
  }
  if(data.type==='reactions'){reactions=data.reactions||reactions;chartEvents.push({at:Date.now(),kind:'reaction'});if(chartEvents.length>20)chartEvents.shift();renderReactions();renderMetrics();renderChart();return;}
  if(data.type==='activity'){activity.push(data.item);if(activity.length>40)activity.shift();renderActivity();return;}
  if(data.type==='selected_student'){selectedStudentId=data.studentId||null;renderStudents();renderWorkspace();return;}
  if(data.type==='workspace'){workspace=data.workspace||workspace;renderWorkspace();renderStudents();renderCanvas();return;}
  if(data.type==='workspace_stroke'){workspace.strokes=workspace.strokes||[];workspace.strokes.push(data.stroke);workspace.revision=data.revision||workspace.revision;renderCanvas();return;}
  if(data.type==='workspace_note'){workspace.note=data.note||'';workspace.revision=data.revision||workspace.revision;renderWorkspaceNote();return;}
}

function renderAll(){renderRoom();renderQuestionStatus();renderMetrics();renderReactions();renderStudents();renderActivity();renderWorkspace();renderCanvas();renderChart();}

function renderQuestionComposer(){
  $$('.qtab').forEach(b=>b.classList.toggle('active',b.dataset.type===questionType));
  const options=$('#optionsArea'); options.innerHTML='';
  $('#fillAnswerArea').classList.toggle('hidden',questionType!=='fill');
  if(questionType==='quiz' || questionType==='poll'){
    optionDefaults.forEach((txt,i)=>{
      const row=document.createElement('div');row.className='option-row';
      row.innerHTML=`<span class="option-letter">${'ABCD'[i]}</span><input data-option="${i}" value="${txt}">${questionType==='quiz'?`<input class="correct-radio" type="radio" name="correct" value="${i}" ${i===0?'checked':''} title="Doğru cevap">`:''}`;
      options.appendChild(row);
    });
  } else if(questionType==='truefalse'){
    ['Doğru','Yanlış'].forEach((txt,i)=>{
      const row=document.createElement('div');row.className='option-row';
      row.innerHTML=`<span class="option-letter">${i===0?'D':'Y'}</span><input data-option="${i}" value="${txt}" readonly><input class="correct-radio" type="radio" name="correct" value="${i}" ${i===0?'checked':''}>`;
      options.appendChild(row);
    });
  } else {
    options.innerHTML='<div class="small muted">Öğrenci cevabını kendi yazar.</div>';
  }
  bindComposerPreview(); renderPreview();
}
function bindComposerPreview(){
  $('#questionPrompt').oninput=renderPreview;
  $$('[data-option]').forEach(x=>x.oninput=renderPreview);
}
function renderPreview(){
  const prompt=$('#questionPrompt').value.trim()||'Sorun burada görünecek.';$('#previewPrompt').textContent=prompt;
  const box=$('#previewOptions');
  if(['quiz','poll','truefalse'].includes(questionType)) box.innerHTML=$$('[data-option]').map(x=>`<div class="preview-option">${escapeHTML(x.value||'Seçenek')}</div>`).join('');
  else box.innerHTML='<div class="preview-option muted">Cevabını buraya yaz...</div>';
}
function gatherQuestion(){
  const prompt=$('#questionPrompt').value.trim(); if(!prompt){toast('Önce soruyu yaz');return null;}
  const q={type:questionType,prompt};
  if(['quiz','poll','truefalse'].includes(questionType)) q.options=$$('[data-option]').map(x=>x.value.trim()).filter(Boolean);
  if(['quiz','truefalse'].includes(questionType)) q.correctIndex=Number($('input[name="correct"]:checked')?.value||0);
  if(questionType==='fill') q.acceptedAnswers=$('#acceptedAnswers').value.split('|').map(x=>x.trim()).filter(Boolean);
  return q;
}
function renderQuestionStatus(){
  const el=$('#questionStatus'); if(currentQuestion){el.textContent='Soru yayında';el.className='badge good'}else{el.textContent='Soru kapalı';el.className='badge dark'}
}

function renderMetrics(){
  $('#metricStudents').textContent=students.length;
  $('#studentCountBadge').textContent=`${students.length} kişi`;
  const answered=students.filter(s=>s.lastAnswer!=null).length;
  const rate=students.length?Math.round(answered/students.length*100):0;$('#metricAnswers').textContent=`${rate}%`;
  const graded=students.filter(s=>s.lastAnswerCorrect!==null && s.lastAnswerCorrect!==undefined);
  if(!currentQuestion || !graded.length) $('#metricCorrect').textContent='—';
  else $('#metricCorrect').textContent=`${Math.round(graded.filter(s=>s.lastAnswerCorrect===true).length/graded.length*100)}%`;
  const warn=(reactions.repeat||0)+(reactions.slower||0); const good=reactions.understood||0;
  $('#metricPulse').textContent=warn>good&&warn>1?'Tekrar':good>2?'İyi':'Sakin';
  $('#chartBadge').textContent=`${answered} cevap`;
}
function renderReactions(){
  $('#reactionUnderstood').textContent=reactions.understood||0;$('#reactionRepeat').textContent=reactions.repeat||0;$('#reactionSlower').textContent=reactions.slower||0;$('#reactionExample').textContent=reactions.example||0;
}
function initials(name='Ö'){return name.split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase()||'Ö'}
function renderStudents(){
  const box=$('#studentList');
  if(!students.length){box.innerHTML='<div class="muted small">Henüz öğrenci yok. Katılım linkini paylaş.</div>';return;}
  box.innerHTML=students.map(s=>{
    const ans=s.lastAnswer!=null?(s.lastAnswerCorrect===true?'Doğru cevap':s.lastAnswerCorrect===false?'Yanlış cevap':'Cevap verdi'):'Bekliyor';
    return `<div class="student-row ${s.id===selectedStudentId?'selected':''} ${s.workspaceControl?'controller':''}" data-student="${escapeHTML(s.id)}">
      <div class="avatar">${escapeHTML(initials(s.name))}</div>
      <div><b>${escapeHTML(s.name)}</b><small>${escapeHTML(ans)}${s.reaction?' • '+escapeHTML(s.reaction):''}</small></div>
      <div class="student-actions"><button data-select="${escapeHTML(s.id)}">Seç</button></div>
    </div>`;
  }).join('');
  $$('[data-select]').forEach(b=>b.onclick=()=>{selectedStudentId=b.dataset.select;send({type:'select_student',studentId:selectedStudentId});renderStudents();renderWorkspace();});
}
function activityIcon(kind){return ({join:'＋',leave:'−',answer:'✓',reaction:'⚡',question:'?',teacher:'●'})[kind]||'•'}
function renderActivity(){
  const box=$('#activityList'); if(!activity.length){box.innerHTML='<div class="muted small">Aktivite bekleniyor.</div>';return;}
  box.innerHTML=activity.slice(-18).reverse().map(a=>`<div class="activity-item"><div class="activity-icon">${activityIcon(a.kind)}</div><div><b>${escapeHTML(a.text)}</b><small>${escapeHTML(a.kind)}</small></div><small>${timeText(a.at)}</small></div>`).join('');
}

function renderChart(){
  const svg=$('#pulseChart');const W=800,H=220,pad=24;
  const events=chartEvents.slice(-20);const step=(W-pad*2)/Math.max(1,events.length-1);
  const pts=events.map((e,i)=>{
    let y=150;if(e.kind==='reaction')y=125;else if(e.correct===true)y=55;else if(e.correct===false)y=105;else y=85;
    return [pad+i*step,y];
  });
  const grid=[50,100,150,200].map(y=>`<line x1="0" y1="${y}" x2="800" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`).join('');
  const path=pts.length?`M ${pts.map(p=>p.join(' ')).join(' L ')}`:'';
  const circles=events.map((e,i)=>{const p=pts[i];const color=e.kind==='reaction'?'#f59e0b':e.correct===true?'#16a34a':'#3b82f6';return `<circle cx="${p[0]}" cy="${p[1]}" r="5" fill="${color}"/>`}).join('');
  svg.innerHTML=`${grid}${path?`<path d="${path}" fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`:''}${circles}${!events.length?'<text x="400" y="112" text-anchor="middle" fill="#94a3b8" font-size="14">Canlı hareket başladığında grafik burada oluşacak</text>':''}`;
}

function renderWorkspace(){
  const selected=students.find(s=>s.id===selectedStudentId);
  $('#workspaceControllerText').textContent=workspace.enabled?`Kontrol: ${students.find(s=>s.id===workspace.controllerStudentId)?.name||'Öğrenci'}`:(selected?`Seçili: ${selected.name}`:'Öğrenci seçilmedi');
  $('#workspaceBadge').textContent=workspace.enabled?'Canlı':'Kapalı';$('#workspaceBadge').className=workspace.enabled?'badge good':'badge';
  $('#toggleWorkspace').textContent=workspace.enabled?'Kontrolü Bitir':'Kontrolü Ver';
  if(workspace.prompt && $('#workspacePrompt').value!==workspace.prompt) $('#workspacePrompt').value=workspace.prompt;
  renderWorkspaceNote();
}
function renderWorkspaceNote(){$('#teacherWorkspaceNote').textContent=workspace.note||'Ortak not henüz yok.';}
function toggleWorkspace(){
  if(workspace.enabled){send({type:'workspace_config',enabled:false});return;}
  if(!selectedStudentId){toast('Önce bir öğrenci seç');return;}
  send({type:'workspace_config',enabled:true,controllerStudentId:selectedStudentId,title:'Ortak Çalışma',prompt:$('#workspacePrompt').value.trim()});
}
function setupCanvas(){
  const c=$('#teacherCanvas');const ctx=c.getContext('2d');
  function point(e){const r=c.getBoundingClientRect();return[(e.clientX-r.left)/r.width*c.width,(e.clientY-r.top)/r.height*c.height]}
  c.addEventListener('pointerdown',e=>{drawState={id:crypto.randomUUID(),color:$('#teacherInkColor').value,width:4,points:[point(e)]};c.setPointerCapture?.(e.pointerId)});
  c.addEventListener('pointermove',e=>{if(!drawState)return;drawState.points.push(point(e));renderCanvas([...workspace.strokes,drawState]);});
  c.addEventListener('pointerup',()=>{if(!drawState)return;const stroke=drawState;drawState=null;workspace.strokes=[...(workspace.strokes||[]),stroke];renderCanvas();send({type:'workspace_stroke',stroke});});
}
function renderCanvas(strokesOverride=null){
  const c=$('#teacherCanvas');if(!c)return;const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,c.width,c.height);
  ctx.strokeStyle='#eef2f7';ctx.lineWidth=1;for(let x=40;x<c.width;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,c.height);ctx.stroke()}for(let y=40;y<c.height;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(c.width,y);ctx.stroke()}
  for(const s of (strokesOverride||workspace.strokes||[])){if(!s.points?.length)continue;ctx.beginPath();ctx.strokeStyle=s.color||'#2563eb';ctx.lineWidth=s.width||4;ctx.lineCap='round';ctx.lineJoin='round';ctx.moveTo(s.points[0][0],s.points[0][1]);for(const p of s.points.slice(1))ctx.lineTo(p[0],p[1]);ctx.stroke()}
}

function applyTemplate(type){
  questionType=type;renderQuestionComposer();
  const examples={truefalse:'Het woord “huis” is een het-woord.',fill:'Ik woon in een ___ huis.',poll:'Bu konu şu an ne kadar anlaşılır?',short:'Bu kuralla kendi cümleni yaz.'};
  $('#questionPrompt').value=examples[type]||'';if(type==='fill')$('#acceptedAnswers').value='groot | mooi | klein';renderPreview();$('#question').scrollIntoView({behavior:'smooth',block:'start'});
}

function bind(){
  $('#startSession').onclick=startSession;$('#heroStart').onclick=startSession;
  $('#copyJoin').onclick=copyJoin;$('#copyJoinRail').onclick=copyJoin;$('#heroCopy').onclick=copyJoin;$('#barLink').onclick=copyJoin;
  $('#openStudentPreview').onclick=()=>{if(!room)startSession();window.open(studentURL(),'_blank','noopener')};
  $$('.qtab').forEach(b=>b.onclick=()=>{questionType=b.dataset.type;renderQuestionComposer()});
  $$('.quick-chip').forEach(b=>b.onclick=()=>applyTemplate(b.dataset.template));
  $('#sendQuestion').onclick=()=>{if(!room)startSession();const q=gatherQuestion();if(!q)return;if(send({type:'question_open',question:q})){toast('Soru öğrencilere gönderildi');}};
  $('#revealQuestion').onclick=()=>send({type:'question_reveal'});$('#closeQuestion').onclick=()=>send({type:'question_close'});
  $('#toggleWorkspace').onclick=toggleWorkspace;$('#workspaceClear').onclick=()=>{workspace.strokes=[];renderCanvas();send({type:'workspace_clear'})};
  $('#workspacePrompt').onchange=()=>{if(workspace.enabled)send({type:'workspace_config',enabled:true,controllerStudentId:workspace.controllerStudentId,title:'Ortak Çalışma',prompt:$('#workspacePrompt').value.trim()})};
  $$('[data-jump]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.jump)?.scrollIntoView({behavior:'smooth',block:'start'}));
  $('#barQuestion').onclick=()=>$('#question').scrollIntoView({behavior:'smooth'});$('#barPoll').onclick=()=>applyTemplate('poll');$('#barStudents').onclick=()=>$('#students').scrollIntoView({behavior:'smooth'});$('#barWorkspace').onclick=()=>$('#workspace').scrollIntoView({behavior:'smooth'});
  setupCanvas();
}

renderRoom();renderQuestionComposer();renderAll();bind();if(room)connect();else setConnection('idle');
