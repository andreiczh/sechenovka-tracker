import { voiceViews } from '/shared/voice-view.js';
import { telegramHeaders } from '/shared/telegram.js';
import { requestJSON, escapeHtml as h } from '/shared/client.js';
import { voiceTimestamp, voiceText } from '/shared/voice-model.js';
import { VoiceRecognizer, splitVoiceResult, decodeVoiceFile, startVoiceCapture, prepareVoiceAudio } from '/shared/voice-capture.js';
let active, knownMicrophones = [];
export async function closeVoice() { if (active) { active.dialog.close(); active.bar.hidden = true; await active.dispose(); } }
const voiceWhen = note => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: note.timeZone || 'Europe/Moscow' }).format(new Date(note.at));
const mic = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
export const voiceButton = (label = 'Заметка голосом', attributes = '') => `<button type="button" class="voice-trigger" data-voice-start aria-label="${h(label)}" title="${h(label)}" ${attributes}>${mic}<span>${h(label)}</span></button>`;
export function voiceNotesSection(notes = [], doctor = false) {
  const visible = notes.filter(n => !n.archivedAt).slice(-3).reverse();
  return `<section class="card voice-notes-card"><div class="card-header card-head"><h2>${doctor ? 'Записи бесед и заметки пациента' : 'Заметки своими словами'}</h2>${doctor ? '<button class="text-link" data-voice-library>Все записи и архив →</button>' : voiceButton('Новая заметка')}</div><p class="small muted">${doctor ? 'Проверенные расшифровки и темы. Запись врача остаётся в кабинете; план публикуется отдельно.' : 'Можно сказать голосом, загрузить аудио или написать. Заметка не заменяет дневник и ответы PHQ-9/GAD-7.'}</p><div class="voice-note-list ${doctor ? 'clinic-note-list' : ''}">${visible.map(n => `<button class="voice-note-link" data-voice-note="${h(n.id)}"><strong>${h(n.title)}</strong><span>${h(voiceWhen(n))} · ${n.scope === 'patient' ? 'со слов пациента' : 'запись врача'}${n.incomplete?' · частичная расшифровка':''}${n.ai?.complete===false?' · неполная структура':''} · ${n.segments.length} фрагм.</span></button>`).join('') || '<p class="small muted">Сохранённых заметок пока нет.</p>'}</div>${doctor ? '' : '<button class="text-link" data-voice-library>Все записи и архив →</button>'}</section>`;
}
function download(text, name, type = 'text/plain;charset=utf-8') { const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function enhanceVoiceFields(root, open) {
  for (const field of root.querySelectorAll('textarea:not([data-voice-enhanced])')) {
    field.dataset.voiceEnhanced = 'true'; const button = document.createElement('button'); button.type = 'button'; button.className = 'voice-field-button'; button.innerHTML = mic + ' Надиктовать'; button.setAttribute('aria-label', 'Надиктовать текст в поле');
    button.addEventListener('click', event => { event.preventDefault(); open({ insertTarget: field }); }); field.insertAdjacentElement('afterend', button);
  }
}
export async function openVoice(options) {
  if (active) { active.dialog.showModal(); active.bar.hidden = true; if (active.options.endpoint !== options.endpoint) active.setStatus('Открыта прежняя незавершённая запись. Сначала сохраните или удалите её.'); return; }
  let context;
  try { if (options.scope === 'vop') await requestJSON('/api/state', { headers: telegramHeaders() }); context = await requestJSON(options.endpoint, { headers: telegramHeaders(), cache: 'no-store' }); }
  catch (error) { options.onError?.(error.message); return; }
  const dialog = document.createElement('dialog'), bar = document.createElement('div'); dialog.className = 'voice-dialog'; dialog.setAttribute('aria-labelledby', 'voice-title'); bar.className = 'voice-recording-bar'; bar.hidden = true;
  document.body.append(dialog, bar);
  const v = active = { options, dialog, bar, context, rows: [], title: '', duration: 0, page: 0, stage: options.library ? 'library' : 'capture', view: 'text', synthetic: false, consent: false, reviewed: false, working: false, pending: 0, modelReady: false, analysis: null, errors: [], engine: 'text-reviewed', cancelled: false, capture: null, playbackUrl: null, microphones: knownMicrophones, microphoneId: '', level: 0 };
  const analysisDialog = document.createElement('dialog'); analysisDialog.className = 'recommendations-dialog'; analysisDialog.dataset.managedDialog = 'true'; analysisDialog.setAttribute('aria-labelledby', 'voice-analysis-title'); document.body.append(analysisDialog); dialog.dataset.managedDialog = 'true';
  const isDoctor = options.scope !== 'patient', perPage = matchMedia('(max-width: 600px)').matches ? 1 : 3;
  const noSignalMessage = 'В записи почти нет звука. Проверьте выбранный микрофон, расстояние до него и уровень сигнала; при необходимости создайте новую запись.';
  function microphonePicker() { return v.microphones.length>1?`<label class="voice-title-field">Микрофон<select data-v-input="microphoneId" ${v.working?'disabled':''}><option value="">По умолчанию</option>${v.microphones.map(d=>`<option value="${h(d.deviceId)}" ${v.microphoneId===d.deviceId?'selected':''}>${h(d.label)}</option>`).join('')}</select></label>`:''; }
  v.setStatus = message => { v.status = message; const el = dialog.querySelector('#voice-status'); if (el) el.textContent = message; const other=analysisDialog.querySelector('#voice-analysis-status');if(other)other.textContent=message; };
  const recognizer = new VoiceRecognizer(v.setStatus);
  const api = body => requestJSON(options.endpoint.split('?')[0], { method: 'POST', headers: { 'Content-Type':'application/json', 'X-Demo-Client':'1', ...telegramHeaders() }, body: JSON.stringify({ ...body, vopContext: options.getContext?.(), scope: options.scope, episodeId: v.context.episodeId, sourceRevision: v.context.sourceRevision }) }, 70000);
  const nextFragmentNumber = () => Math.max(-1, ...v.rows.map(row => Number(row.id.slice(1))), v.removed ? Number(v.removed.row.id.slice(1)) : -1) + 1;
  const addRows = rows => { const start = nextFragmentNumber(); v.rows.push(...rows.map((row, i) => ({ ...row, id: `s${start + i}`, role: options.scope === 'patient' ? 'patient' : row.role }))); v.analysis = null; v.reviewed = false; const reviewed=dialog.querySelector('[data-v-input="reviewed"]'); if(reviewed)reviewed.checked=false; };
  async function recognize(audio, offset) {
    if (v.cancelled) return;
    audio = prepareVoiceAudio(audio); if(!audio)return;
    v.pending++; if (v.pending > 6 && v.capture && !v.capture.paused) { v.capture.pause(); v.setStatus('Сделана пауза: распознавание догоняет запись. Возобновите, когда очередь уменьшится.'); }
    try { const result = await recognizer.transcribe(audio); if (!v.cancelled) addRows(splitVoiceResult(result, offset)); }
    catch (error) { if (!v.cancelled) v.errors.push(`${voiceTimestamp(offset)}: ${error.message}`); }
    finally { v.pending--; if (!v.cancelled) { v.setStatus(v.pending ? `Распознаём: осталось фрагментов ${v.pending}` : v.errors.length ? 'Часть аудио не распознана. Прослушайте запись и дополните текст.' : v.rows.some(row=>row.text.trim()) ? 'Распознавание завершено. Проверьте текст, отрицания, даты и названия.' : v.capture ? 'Запись идёт. Речь пока не распознана; говорите ближе к микрофону и следите за уровнем сигнала.' : 'Речь не распознана. Прослушайте запись, проверьте микрофон и повторите; можно вписать текст.'); if (!v.capture && !v.working) { v.stage = 'review'; render(); } } }
  }
  const setPlayback = blob => { if (v.cancelled) return; if (v.playbackUrl) URL.revokeObjectURL(v.playbackUrl); v.playbackBlob = blob; v.playbackUrl = URL.createObjectURL(blob); };
  const clearPlayback = () => { if (v.playbackUrl) URL.revokeObjectURL(v.playbackUrl); v.playbackBlob=null;v.playbackUrl=null; };
  const ui = voiceViews(v, { isDoctor, perPage, microphonePicker, mic, voiceWhen });
  function render() {
    if(v.cancelled)return;
    dialog.innerHTML=ui.header()+`<div class="voice-body">${v.stage==='capture'?ui.captureBody():v.stage==='recording'?ui.recordingBody():v.stage==='saved'?ui.savedBody():v.stage==='library'?`${ui.destinationCard()}<h3>Сохранённые записи</h3>${[...v.context.notes,...(v.context.sharedNotes||[])].slice().reverse().map(n=>`<button class="voice-note-link" data-v-record="${n.id}"><strong>${h(n.title)}</strong><span>${h(voiceWhen(n))} · ${n.scope==='patient'?'заметка пациента':'беседа врача'} · ${n.archivedAt?'в архиве':'сохранено'}</span></button>`).join('')||'<p>Пока нет записей. Создайте первую — она появится здесь.</p>'}<button data-v="new" class="voice-primary">Новая запись</button>`:ui.reviewBody()}</div>`+ui.footer();
    if(v.working)for(const b of dialog.querySelectorAll('button:not([data-v="minimize"])'))b.disabled=true;
    if(analysisDialog.open)analysisDialog.innerHTML=ui.analysisBody();
    if(v.focusRow&&dialog.open){dialog.querySelector('[data-v-text="'+v.focusRow+'"]')?.focus({preventScroll:true});v.focusRow=null;}
  }
  async function dispose() { v.cancelled=true;v.captureAbort?.abort();v.cancelWait?.(); if(v.capture)await v.capture.stop(); recognizer.dispose(); if(v.playbackUrl)URL.revokeObjectURL(v.playbackUrl); v.rows=[];v.analysis=null;v.playbackBlob=null;v.playbackUrl=null;v.existing=null;dialog.remove();bar.remove();analysisDialog.remove();window.removeEventListener('beforeunload',unload);active=null; }
  v.dispose = dispose;
  const unload = event => { if(v.capture||v.rows.length&&!v.existing){event.preventDefault();event.returnValue='';} }; window.addEventListener('beforeunload',unload);
  function checkConsent() { if(!v.synthetic||isDoctor&&!v.consent)throw new Error('Сначала подтвердите тестовый характер записи'+(isDoctor?' и согласие всех участников.':'.')); }
  async function importBlob(blob) { checkConsent();v.importing=true;v.working=true;render();try{const decoded=await decodeVoiceFile(blob,options.scope==='patient'?300:600);if(v.cancelled)return;v.duration=decoded.duration;setPlayback(blob);await recognizer.load();v.engine='whisper-base-device';for(let offset=0;offset<decoded.audio.length;offset+=400000){if(v.cancelled)break;await recognize(decoded.audio.slice(offset,offset+400000),offset/16000);}v.stage='review';}finally{v.importing=false;v.working=false;render();} }
  function handleInput(event) {const key=event.target.dataset.vInput;if(key)v[key]=event.target.type==='checkbox'?event.target.checked:event.target.value;const id=event.target.dataset.vText;if(id){const row=v.rows.find(r=>r.id===id);row.text=event.target.value;row.topics=[];v.analysis=null;v.reviewed=false;}const role=event.target.dataset.vRole;if(role){v.rows.find(r=>r.id===role).role=event.target.value;v.rows.find(r=>r.id===role).roleSource='manual';v.reviewed=false;}if(id||role){const reviewed=dialog.querySelector('[data-v-input="reviewed"]');if(reviewed)reviewed.checked=false;const analyze=dialog.querySelector('[data-v="open-analysis"]');if(analyze)analyze.disabled=Boolean(v.pending||options.urgent||!v.rows.some(r=>r.text.trim()));}}
  dialog.addEventListener('input',handleInput); analysisDialog.addEventListener('input',handleInput);
  dialog.addEventListener('change',async event=>{if(event.target.id!=='voice-file'||!event.target.files[0])return;try{await importBlob(event.target.files[0]);}catch(error){v.working=false;
      if(error.status===409){try{const fresh=await requestJSON(options.endpoint,{headers:telegramHeaders(),cache:'no-store'});if(fresh.episodeId===v.context.episodeId){v.context=fresh;v.analysis=null;v.rows.forEach(r=>{r.topics=[]});v.reviewed=false;v.stage='review';v.status='В профиле появились новые данные. Текст сохранён на экране; перепроверьте его и заново подтвердите сохранение. ИИ-структуру нужно обновить.';render();return;}}catch{/* Preserve the draft on connection failure. */}}
      render();v.setStatus(error.message);
    }});
  const minimize = async () => {
    if(v.capture||v.rows.length&&!v.existing){dialog.close();bar.hidden=false;bar.querySelector('[data-bar=stop]').hidden=!v.capture;bar.querySelector('#voice-bar-label').textContent=v.capture?'Идёт запись':'Продолжить черновик';}
    else await dispose();
  };
  dialog.addEventListener('cancel',event=>{event.preventDefault();void minimize();});
  analysisDialog.addEventListener('close',()=>{if(v.stage==='consent'){v.stage='review';render();}});
  analysisDialog.addEventListener('click',event=>{if(event.target.closest('[data-va-close]'))analysisDialog.close();});
  bar.innerHTML=`<button data-bar="open">${mic}<span id="voice-bar-label">Идёт запись</span></button><button data-bar="stop">Остановить</button>`;
  bar.addEventListener('click',event=>{if(event.target.closest('[data-bar="open"]')){dialog.showModal();bar.hidden=true;}else if(event.target.closest('[data-bar="stop"]')){dialog.showModal();bar.hidden=true;dialog.querySelector('[data-v="stop"]')?.click();}});
  async function handleClick(event) {
    const remove=event.target.closest('[data-v-remove]');if(remove){const index=v.rows.findIndex(r=>r.id===remove.dataset.vRemove);if(index>=0){v.removed={row:v.rows[index],index};v.rows.splice(index,1);v.analysis=null;v.reviewed=false;render();}return;}
    const split=event.target.closest('[data-v-split]');if(split){const row=v.rows.find(r=>r.id===split.dataset.vSplit),field=dialog.querySelector('[data-v-text="'+row.id+'"]');const at=field.selectionStart;if(at<=0||at>=row.text.length){v.setStatus('Поставьте курсор внутри реплики в месте смены говорящего, затем нажмите «Разделить».');return;}const index=v.rows.indexOf(row),tail={...row,id:'s'+nextFragmentNumber(),text:row.text.slice(at).trim(),role:options.scope==='patient'?'patient':'unknown',roleSource:'unreviewed',topics:[]};row.text=row.text.slice(0,at).trim();row.topics=[];v.rows.splice(index+1,0,tail);v.analysis=null;v.reviewed=false;v.focusRow=tail.id;render();return;}
    const record=event.target.closest('[data-v-record]');if(record){clearPlayback();v.existing=[...v.context.notes,...(v.context.sharedNotes||[])].find(n=>n.id===record.dataset.vRecord);v.rows=structuredClone(v.existing.segments);v.title=v.existing.title;v.stage='review';v.view='text';v.page=0;v.analysis=null;v.errors=[];render();return;}
    const command=event.target.closest('[data-v]')?.dataset.v;if(!command||v.working&&!['minimize','cancel-ai'].includes(command))return;
    try{
      if(command==='cancel-ai'){v.cancelAnalysis=true;v.cancelWait?.();v.setStatus('Остановим после текущей части; готовый текст и структура останутся.');return;}
      if(command==='discard'){await dispose();return;}
      if(command==='minimize'){await minimize();return;}
      if(command==='open-analysis'){analysisDialog.innerHTML=ui.analysisBody();analysisDialog.showModal();return;}
      if(command==='read-saved')v.stage='review';
      if(command==='go-destination'){if(options.scope==='vop'){v.stage='library';v.existing=null;v.rows=[];v.analysis=null;v.title='';v.status='';clearPlayback();}else{const target=options.savedHref||'#diary';await dispose();location.hash=target;return;}}
      if(command==='undo-remove'&&v.removed){v.rows.splice(v.removed.index,0,v.removed.row);v.removed=null;v.reviewed=false;v.analysis=null;}
      if(command==='confirm-discard'){v.discardFrom=v.stage;v.stage='discard';dialog.innerHTML=ui.header()+`<div class="voice-body"><h3>Убрать несохранённый черновик?</h3><p>Его текст и аудио будут убраны с этого устройства. Сохранённые записи останутся.</p><div class="voice-capture-actions"><button data-v="discard" class="voice-primary">Убрать черновик</button><button data-v="keep-draft" class="voice-small">Вернуться к тексту</button></div></div>`;return;}
      if(command==='keep-draft')v.stage=v.discardFrom||'review';
      if(command==='edit-copy'){v.synthetic=v.existing.synthetic;v.consent=options.scope==='patient'||v.existing.participantsConsent;v.duration=v.existing.duration;v.engine=v.existing.engine;v.errors=v.existing.incomplete?['Исходная расшифровка частичная.']:[];v.existing=null;v.removed=null;v.stage='review';v.analysis=null;v.reviewed=false;v.title=(v.title+' · уточнение').slice(0,120);v.context=await requestJSON(options.endpoint,{headers:telegramHeaders(),cache:'no-store'});v.status='Будет сохранена новая версия. Исходная запись останется в истории.';}
      if(command==='new'){clearPlayback();v.existing=null;v.rows=[];v.removed=null;v.analysis=null;v.stage='capture';v.page=0;v.view='text';v.title='';v.duration=0;v.errors=[];v.engine='text-reviewed';v.synthetic=false;v.consent=false;v.reviewed=false;v.aiConsent=false;}
      if(command==='library'){if(v.rows.length&&!v.existing){v.setStatus('Сначала сохраните текущий текст или уберите черновик.');return;}v.context=await requestJSON(options.endpoint,{headers:telegramHeaders(),cache:'no-store'});clearPlayback();v.stage='library';v.existing=null;v.rows=[];v.analysis=null;v.title='';v.status='';}
      if(command==='manual'){checkConsent();v.stage='review';if(!v.rows.length)addRows([{text:'',start:null,end:null,role:options.scope==='patient'?'patient':'unknown',topics:[]}]);v.focusRow=v.rows[0]?.id;}
      if(command==='record'){
        checkConsent();v.working=true;v.captureAbort=new AbortController();v.setStatus('Ожидаем разрешение микрофона в браузере. Разрешите доступ; при отмене можно закрыть это окно.');render();
        v.capture=await (options.createCapture || startVoiceCapture)({signal:v.captureAbort.signal,deviceId:v.microphoneId,onLevel:level=>{v.level=Math.min(1,Math.sqrt(level*20));const meter=dialog.querySelector("#voice-level");if(meter)meter.value=v.level;},onSetup:phase=>v.setStatus({visibility:'Safari скрыл страницу. Вернитесь в это окно: ожидание разрешения приостановлено, запись ещё не началась.',permission:'Ожидаем разрешение микрофона. Разрешите доступ в браузере.',processor:'Микрофон доступен. Подготавливаем запись…',audio:'Включаем звук в браузере…'}[phase]),maximumSeconds:options.scope==='patient'?300:3600,onEnded:(result,reason)=>{v.capture=null;if(result){setPlayback(result.blob);v.duration=result.duration;if(result.hasSound===false)v.errors.push(noSignalMessage);}v.stage='review';v.status=reason==='limit'?'Достигнут предел; запись остановлена. Проверьте текст.':'Запись прервалась. Доступные фрагменты остаются; проверьте полноту.';render();},onChunk:(audio,offset)=>{void recognize(audio,offset);},onState:(status,seconds)=>{v.duration=seconds;const time=dialog.querySelector('#voice-time');if(time)time.textContent=voiceTimestamp(seconds);const state=dialog.querySelector('#voice-recording-state');if(state)state.textContent=status==='recording'?'Идёт запись':'Пауза';const count=dialog.querySelector('#voice-recognized-count');if(count)count.textContent=v.rows.length;bar.querySelector('#voice-bar-label').textContent=`${voiceTimestamp(seconds)} · ${options.ownerLabel||'Запись'}${status!=='recording'?' · пауза':''}`;if(status==='hidden')v.setStatus('Запись на паузе после переключения окна. Вернитесь и нажмите «Продолжить».');if(status==='limit')v.setStatus('Достигнут предел записи. Остановите и проверьте текст.');}});
        if(v.cancelled){await v.capture?.stop();v.capture=null;return;}void refreshMicrophones();v.engine='whisper-base-device';v.stage='recording';v.working=false;v.status='Микрофон включён. Можно свернуть окно и продолжить работу.';void recognizer.load().catch(error=>{if(!v.cancelled){v.errors.push(error.message);v.setStatus('Звук записывается, но распознавание пока недоступно. После остановки можно скачать аудио и дополнить текст.');}});
      }
      if(command==='pause'){v.capture.paused?v.capture.resume():v.capture.pause();return;}
      if(command==='stop'){const result=await v.capture.stop();v.capture=null;if(result){setPlayback(result.blob);v.duration=result.duration;if(result.hasSound===false)v.errors.push(noSignalMessage);}v.stage='review';v.setStatus(v.pending?'Дораспознаём оставшиеся фрагменты…':'Проверьте текст и роли перед сохранением.');}
      if(command==='abort-recognition'){recognizer.dispose();v.errors.push('Распознавание остановлено пользователем; запись частичная.');v.status='Обработка остановлена. Можно проверить и сохранить готовые фрагменты.';}
      if(command==='previous')v.page=Math.max(0,v.page-1);
      if(command==='next')v.page++;
      if(command==='add'){addRows([{text:'',start:null,end:null,role:options.scope==='patient'?'patient':'unknown',topics:[]}]);v.page=Math.floor((v.rows.length-1)/perPage);v.focusRow=v.rows.at(-1)?.id;}
      if(command.startsWith('view-')){v.view=command.slice(5);v.page=0;}
      if(command==='back')v.stage='review';
      if(command==='consent'){checkConsent();v.stage='consent';v.aiConsent=false;}
      if(command==='analyze'){
        if(!v.aiConsent)throw new Error('Подтвердите обработку вымышленного текста.');v.working=true;render();
        const allRows=v.rows.filter(r=>r.text.trim()),batches=[];let batch=[],length=0;
        for(const row of allRows){if(batch.length>=100||length+row.text.length>16000){batches.push(batch);batch=[];length=0;}batch.push(row);length+=row.text.length;}if(batch.length)batches.push(batch);
        if(!batches.length)throw new Error('Сначала добавьте текст.');
        v.cancelAnalysis=false;let lastStarted=0,previousCached=true,results=[];
        for(let i=0;i<batches.length&&!v.cancelAnalysis;i++){
          if(!previousCached&&Date.now()-lastStarted<21000){v.setStatus(`Разбор ${i+1} из ${batches.length}: короткая пауза бесплатного сервиса…`);await new Promise(resolve=>{const timer=setTimeout(resolve,21000-(Date.now()-lastStarted));v.cancelWait=()=>{clearTimeout(timer);resolve();};});v.cancelWait=null;}
          if(v.cancelAnalysis||v.cancelled)break;v.setStatus(`Структурируем часть ${i+1} из ${batches.length}…`);lastStarted=Date.now();
          const result=await api({op:'analyze',segments:batches[i],synthetic:true,participantsConsent:v.consent,aiConsent:true});previousCached=result.cached;results.push(result.analysis);
          for(const row of v.rows){const turn=result.analysis.turns.find(t=>t.id===row.id);if(turn){if(row.roleSource!=='manual')row.role=turn.role;row.topics=turn.topics;}}
        }
        if(v.cancelled)return;const last=results.at(-1);v.analysis=last?{...last,questions:[...new Set(results.flatMap(r=>r.questions))]}:null;v.reviewed=false;v.stage='review';v.view='topics';v.page=0;v.working=false;v.status=v.cancelAnalysis?'Структурирование остановлено. Готовые части сохранены; проверьте полноту.':'Структура готова. Вернитесь к тексту и проверьте предложенные роли.';
      }
      if(command==='save'){
        if(v.pending)throw new Error('Дождитесь распознавания всех фрагментов или остановите его, затем проверьте текст.');
        if(options.isCurrent&&!options.isCurrent())throw new Error('Сейчас открыта другая карточка или эпизод. Вернитесь к профилю, указанному в заголовке записи.');
        checkConsent();if(!v.reviewed)throw new Error('Сначала подтвердите проверку расшифровки и ролей.');v.working=true;render();
        const result=await api({op:'save',segments:v.rows.filter(r=>r.text.trim()),title:v.title,duration:v.duration,engine:v.engine,incomplete:v.errors.length>0,synthetic:true,participantsConsent:v.consent,reviewed:true});
        v.context=result;v.stage='saved';v.existing=result.notes.find(n=>n.id===result.savedId);v.rows=structuredClone(v.existing.segments);v.analysis=null;v.working=false;v.status=options.scope==='vop'?'Беседа и текущие отметки ВОП сохранены. Профиль пациента автоматически не выбран.':isDoctor?'Расшифровка сохранена в кабинете. План пациента не изменён.':'Заметка сохранена. Анкеты и дневник не изменены.';await options.onSaved?.();
      }
      if(command==='archive'){v.context=await api({op:v.existing.archivedAt?'restore':'archive',id:v.existing.id});v.existing=v.context.notes.find(n=>n.id===v.existing.id);v.status=v.existing.archivedAt?'Перенесено в архив; можно восстановить.':'Запись восстановлена.';await options.onSaved?.();}
      if(command==='export-audio'){const type=v.playbackBlob.type,extension=type.includes('mp4')?'m4a':type.includes('ogg')?'ogg':type.includes('wav')?'wav':'webm';download(v.playbackBlob,'sechenovka-recording.'+extension,type||'audio/webm');}
      if(command==='export')download(voiceText(v.existing||{scope:options.scope,title:v.title,segments:v.rows,questions:v.analysis?.questions||[],at:new Date().toISOString()}),'sechenovka-voice.txt');
      if(command==='insert'){if(v.pending)throw new Error('Дождитесь распознавания или остановите его перед вставкой.');if(!v.reviewed)throw new Error('Сначала проверьте текст и подтвердите это галочкой.');if(!options.insertTarget?.isConnected)throw new Error('Исходное поле уже закрыто. Скопируйте текст из TXT или откройте поле заново.');const field=options.insertTarget;const proposed=field.value+(field.value.trim()?'\n':'')+v.rows.map(r=>r.text).join(' ');if(field.maxLength>0&&proposed.length>field.maxLength)throw new Error('Для этого поля допускается до '+field.maxLength+' знаков. Сократите текст перед вставкой.');field.value=proposed;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));await dispose();return;}
      if(command==='telegram-inbox'){checkConsent();v.importing=true;v.working=true;render();const response=await fetch('/api/voice/audio',{headers:telegramHeaders(),cache:'no-store',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Голосовое недоступно или устарело. Отправьте новое в бот.');v.working=false;await importBlob(await response.blob());}
      render();
    }catch(error){v.working=false;
      if(error.status===409){try{const fresh=await requestJSON(options.endpoint,{headers:telegramHeaders(),cache:'no-store'});if(fresh.episodeId===v.context.episodeId){v.context=fresh;v.analysis=null;v.rows.forEach(r=>{r.topics=[]});v.reviewed=false;v.stage='review';v.status='В профиле появились новые данные. Текст сохранён на экране; перепроверьте его и заново подтвердите сохранение. ИИ-структуру нужно обновить.';render();return;}}catch{/* Preserve the draft on connection failure. */}}
      render();v.setStatus(error.message);
    }
  }
  dialog.addEventListener('click',handleClick);analysisDialog.addEventListener('click',handleClick);
  if(options.existing){v.existing=options.existing;v.rows=structuredClone(options.existing.segments);v.title=options.existing.title;v.stage='review';}
  render();dialog.showModal();
  void refreshMicrophones();
  async function refreshMicrophones(){try{const devices=await navigator.mediaDevices?.enumerateDevices?.();if(v.cancelled||!devices)return;const available=devices.filter(d=>d.kind==='audioinput'&&d.label);if(available.length){knownMicrophones=available;v.microphones=available;if(v.stage==='capture')render();}}catch{/* Device selection stays optional. */}}
}
