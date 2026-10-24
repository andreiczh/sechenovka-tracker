import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createHistory, createPatient } from '../lib/patient.mjs';
import { createClinicianWorkspace, clinicianPatient } from '../lib/clinician.mjs';
import { createVoiceService, validateVoiceSelection, redactVoiceText } from '../lib/voice.mjs';
import { normalizeVoiceSegments, voiceText } from '../public/shared/voice-model.js';
import { createVoiceAssets } from '../lib/voice-assets.mjs';
import { createAppServer } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { createTelegram } from '../lib/telegram.mjs';
import { telegramSessionId } from '../lib/telegram-auth.mjs';
import { emptyTherapyContext, saveTherapyContext, THERAPY_FIELDS } from '../lib/therapy-support.mjs';
import { voiceSummary } from '../public/shared/voice-model.js';
import { startVoiceCapture, prepareVoiceAudio } from '../public/shared/voice-capture.js';
const NOW = Date.parse('2026-10-24T08:00:00Z');
const rows = [{ id: 's0', start: 0, end: 3, text: 'Что стало труднее делать?', role: 'doctor' }, { id: 's1', start: 3, end: 9, text: 'Мне трудно заснуть. Дозу я не менял.', role: 'patient' }];
const config = readConfig({ OPENROUTER_API_KEY: 'synthetic_key_not_real_123456', AI_PROVIDER: 'openrouter' });
function fixture(t) {
  const store = createStore(':memory:'); t.after(() => store.close()); let now = NOW, calls = 0, sent;
  store.save('owner', createHistory(NOW)); store.saveWorkspace('owner', createClinicianWorkspace(NOW));
  const run = createVoiceService({ store, config, wallClock: () => now, fetchImpl: async (url, init) => { calls++; const body = JSON.parse(init.body);sent = JSON.parse(body.messages.at(-1).content);return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ turns: sent.fragments.map((r,i) => ({ id:r.id, role:i?'patient':'doctor', topics:i?['sleep','medicines']:['function'] })), questions:['sleep','medicines'] }) } }], usage:{prompt_tokens:123,completion_tokens:44,cost:0} })); } });
  return {store,run,get calls(){return calls},get sent(){return sent},advance:()=>{now+=21000}};
}
test('voice structure preserves source words and negation, validates references and never invents clinical content', () => {
  const normalized = normalizeVoiceSegments(rows,'psychiatrist');assert.equal(normalized[1].text,'Мне трудно заснуть. Дозу я не менял.');
  const valid = { turns: rows.map(r=>({id:r.id,role:r.role,topics:['sleep']})),questions:['sleep'] };
  assert.equal(validateVoiceSelection(valid,normalized,'patient').turns.every(t=>t.role==='patient'),true);
  for(const bad of [{...valid,turns:[{id:'invented',role:'patient',topics:[]}]},{...valid,questions:['take-aviandr']},{...valid,turns:[valid.turns[0],valid.turns[0]]},{...valid,turns:[valid.turns[0],{id:'s1',role:'patient',topics:['diagnosis']}]}])assert.throws(()=>validateVoiceSelection(bad,normalized,'psychiatrist'));
  for(const values of [[{...rows[0],start:-1}],[{...rows[0],text:'a'.repeat(1201)}]])assert.throws(()=>normalizeVoiceSegments(values));
  const report=voiceText({scope:'patient',segments:normalized,questions:['medicines']});assert.match(report,/Дозу я не менял/);assert.match(report,/автоматически не изменяются/);
  assert.doesNotMatch(redactVoiceText('test@example.test +7 (999) 123-45-67'),/example|999/);assert.equal(redactVoiceText('2026-10-24'),'2026-10-24');
});
test('patient voice requires review, does not answer a questionnaire, persists and archives reversibly',async t=>{
  const f=fixture(t), before=f.store.get('owner'), args={sessionId:'owner',scope:'patient'};let c=await f.run(args);
  const action={op:'save',episodeId:c.episodeId,sourceRevision:c.sourceRevision,segments:rows,title:'Тестовая заметка',duration:9,synthetic:true};
  await assert.rejects(f.run({...args,action}),/проверьте текст/);
  c=await f.run({...args,action:{...action,reviewed:true}});const saved=f.store.get('owner');
  assert.deepEqual(saved.assessments,before.assessments);assert.deepEqual(saved.diary,before.diary);assert.equal(saved.voiceNotes.length,1);assert.equal(saved.voiceNotes[0].segments.every(r=>r.role==='patient'),true);
  await assert.rejects(f.run({...args,action:{...action,reviewed:true}}),/изменились/);
  c=await f.run({...args,action:{op:'archive',episodeId:c.episodeId,sourceRevision:c.sourceRevision,id:c.savedId}});assert.ok(c.notes[0].archivedAt);
  c=await f.run({...args,action:{op:'restore',episodeId:c.episodeId,sourceRevision:c.sourceRevision,id:c.notes[0].id}});assert.equal(c.notes[0].archivedAt,null);
});
test('physician voice uses patient context, caches inference, keeps notes private and invalidates stale decisions',async t=>{
  const f=fixture(t),args={sessionId:'owner',scope:'psychiatrist',patientId:'anna'};const before=clinicianPatient(f.store.getWorkspace('owner'),'anna',f.store.get('owner'),NOW);let c=await f.run(args);
  const input={episodeId:c.episodeId,sourceRevision:c.sourceRevision,segments:rows,synthetic:true,participantsConsent:true};
  await assert.rejects(f.run({...args,action:{...input,op:'analyze'}}),/Подтвердите отправку/);
  const ai=await f.run({...args,action:{...input,op:'analyze',aiConsent:true}});assert.equal(ai.analysis.usage.cost,0);assert.equal(f.calls,1);assert.ok(f.sent.context.length);assert.doesNotMatch(JSON.stringify(f.sent),/Анна|PRIVATE/);
  assert.equal((await f.run({...args,action:{...input,op:'analyze',aiConsent:true}})).cached,true);assert.equal(f.calls,1);
  c=await f.run({...args,action:{...input,op:'save',title:'PRIVATE-VOICE-CLINIC',duration:9,reviewed:true}});
  const after=clinicianPatient(f.store.getWorkspace('owner'),'anna',f.store.get('owner'),NOW);assert.equal(after.voiceNotes.length,1);assert.ok(after.voiceNotes[0].questions.includes('sleep'));assert.ok(after.voiceNotes[0].questions.includes('safety'));assert.notEqual(after.sourceRevision,before.sourceRevision);assert.deepEqual(after.review.confirmed,before.review.confirmed);
  assert.equal(f.store.get('owner').voiceNotes,undefined);assert.doesNotMatch(JSON.stringify(f.store.get('owner')),/PRIVATE-VOICE-CLINIC/);
  const other=await f.run({...args,patientId:'olga'});assert.equal(other.notes.length,0);
  await assert.rejects(f.run({...args,action:{...input,op:'save',title:'stale',duration:9,reviewed:true}}),/изменились/);
});
test('an inference completed after patient changes is rejected without publishing a plan',async t=>{
  const f=fixture(t);let release,entered;const gate=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r});
  const run=createVoiceService({store:f.store,config,wallClock:()=>NOW,fetchImpl:async()=>{entered();await gate;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({turns:rows.map(r=>({id:r.id,role:r.role,topics:[]})),questions:[]})}}],usage:{cost:0}}));}});
  const args={sessionId:'owner',scope:'patient'},c=await run(args);const task=run({...args,action:{op:'analyze',segments:rows,episodeId:c.episodeId,sourceRevision:c.sourceRevision,synthetic:true,aiConsent:true}});await started;
  await f.store.withSession('owner',async t=>{const s=await t.get('owner');s.revision++;await t.save('owner',s)});release();await assert.rejects(task,/данные изменились/);assert.equal(f.store.get('owner').voiceNotes,undefined);
});
test('a new or archived physician transcript requires a fresh medicine check and never changes a confirmed plan',async t=>{
  const f=fixture(t),args={sessionId:'owner',scope:'psychiatrist',patientId:'anna'},workspace=f.store.getWorkspace('owner');
  const before=clinicianPatient(workspace,'anna',f.store.get('owner'),NOW);
  const values={...emptyTherapyContext(),diagnosis:'gad',evidence:'Вымышленная проверка врачом',checks:Object.fromEntries(THERAPY_FIELDS.map(([id,,kind])=>[id,kind==='positive'?'yes':'no']))};
  assert.equal(saveTherapyContext(workspace,before,{values,episodeId:before.episodeId,sourceRevision:before.sourceRevision,contextRevision:0},NOW).status,200);f.store.saveWorkspace('owner',workspace);
  assert.equal(clinicianPatient(f.store.getWorkspace('owner'),'anna',f.store.get('owner'),NOW).therapy.status,'consider');
  let c=await f.run(args);c=await f.run({...args,action:{op:'save',episodeId:c.episodeId,sourceRevision:c.sourceRevision,segments:rows,title:'Новые сведения из беседы',duration:9,synthetic:true,participantsConsent:true,reviewed:true}});
  let p=clinicianPatient(f.store.getWorkspace('owner'),'anna',f.store.get('owner'),NOW);assert.equal(p.therapy.status,'stale');assert.deepEqual(p.review.confirmed,before.review.confirmed);
  c=await f.run({...args,action:{op:'archive',id:c.savedId,episodeId:c.episodeId,sourceRevision:c.sourceRevision}});
  p=clinicianPatient(f.store.getWorkspace('owner'),'anna',f.store.get('owner'),NOW);assert.equal(p.therapy.status,'stale');assert.deepEqual(p.review.confirmed,before.review.confirmed);assert.equal(f.calls,0);
});
test('unresolved patient safety blocks external voice analysis but permits reviewed manual notes without clearing safety',async t=>{
  const f=fixture(t),args={sessionId:'owner',scope:'patient'};const state=f.store.get('owner');state.safety={level:'urgent',pending:true,needsGuidance:true};f.store.save('owner',state);
  let c=await f.run(args);const action={episodeId:c.episodeId,sourceRevision:c.sourceRevision,segments:rows,synthetic:true,aiConsent:true};
  await assert.rejects(f.run({...args,action:{...action,op:'analyze'}}),error=>error.status===422&&/оценка безопасности/.test(error.message));assert.equal(f.calls,0);
  c=await f.run({...args,action:{...action,op:'save',reviewed:true,title:'Проверенный тестовый текст',duration:9}});
  assert.equal(c.notes.length,1);assert.deepEqual(f.store.get('owner').safety,state.safety);assert.equal(f.calls,0);
});
test('voice API isolates patients, requires clinic login and rejects raw audio uploads and unsafe origins',async t=>{
  const store=createStore(':memory:');const server=createAppServer({config:readConfig({CLINICIAN_ACCESS_KEY:'synthetic_clinic_key_1234567890'}),storage:store,logger:()=>{}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.close();await once(server,'close')});const origin='http://127.0.0.1:'+server.address().port;
  const r=await fetch(origin+'/api/state'),cookie=r.headers.get('set-cookie').split(';')[0];let s=await r.json();
  const post=(path,body,extra={})=>fetch(origin+path,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Demo-Client':'1',...extra},body:JSON.stringify(body)});
  s=await(await post('/api/action',{type:'join',adult:true,revision:s.revision})).json();let c=await(await fetch(origin+'/api/voice',{headers:{Cookie:cookie}})).json();
  const note=await post('/api/voice',{op:'save',scope:'patient',episodeId:c.episodeId,sourceRevision:c.sourceRevision,synthetic:true,reviewed:true,title:'OWN-VOICE',duration:9,segments:rows});assert.equal(note.status,200);
  assert.equal((await(await fetch(origin+'/api/state')).json()).voiceNotes,undefined);
  assert.equal((await fetch(origin+'/api/clinic/patients/care-00000000-0000-4000-8000-000000000001/voice')).status,401);
  assert.equal((await post('/api/voice',{op:'save'},{Origin:'https://hostile.example'})).status,403);
  assert.equal((await fetch(origin+'/api/voice',{method:'POST',headers:{Cookie:cookie,'Content-Type':'audio/wav'},body:Buffer.alloc(128)})).status,403);
  assert.equal((await fetch(origin+'/api/voice/audio',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await fetch(origin+'/voice-assets/not-allowlisted.onnx')).status,404);
});

test('Telegram voice is an expiring inbox, not an answer; playback is limited to the authenticated owner',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());let now=NOW,downloads=0,sends=0;
  const c=readConfig({PUBLIC_ORIGIN:'https://bot.example',TELEGRAM_BOT_TOKEN:'123456:synthetic_token_for_tests_not_a_real_key',TELEGRAM_WEBHOOK_SECRET:'synthetic_webhook_secret_123456789012',TELEGRAM_IDENTITY_SECRET:'synthetic_identity_secret_123456789012'});
  const user=123456789,id=telegramSessionId(user,c.telegramIdentitySecret),state=createHistory(NOW);store.save(id,state);const persistedBefore=store.get(id);
  const bot=createTelegram({config:c,store,wallClock:()=>now,callApi:async(method)=>method==='getFile'?{file_path:'voice/file_1.oga',file_size:4}:{message_id:++sends},fileFetch:async url=>{assert.ok(url.startsWith('https://api.telegram.org/file/bot'));downloads++;return new Response(new Uint8Array([1,2,3,4]));}});
  const update={update_id:1,message:{message_id:1,from:{id:user,is_bot:false},chat:{id:user,type:'private'},voice:{file_id:'synthetic-file-id',duration:8,file_size:4}}};
  assert.equal((await bot.handleUpdate(update)).ok,true);const after=store.get(id);assert.deepEqual(after.assessments,persistedBefore.assessments);assert.deepEqual(after.diary,persistedBefore.diary);assert.deepEqual(after.active,persistedBefore.active);
  const meta=await bot.readVoice(id);assert.equal(meta.available,true);assert.equal(meta.fileId,undefined);assert.equal((await bot.readVoice(id,true)).bytes.length,4);assert.equal(downloads,1);
  assert.equal((await bot.readVoice('another-owner')).available,false);
  const before=sends;await bot.handleUpdate(update);assert.equal(sends,before);
  await bot.handleUpdate({update_id:2,message:{message_id:2,from:{id:user,is_bot:false},chat:{id:user,type:'private'},audio:{file_id:'synthetic-audio-id',duration:8,file_size:4,mime_type:'audio/mp4'}}});assert.equal((await bot.readVoice(id)).available,true);assert.deepEqual(store.get(id).active,persistedBefore.active);
  await bot.handleUpdate({update_id:3,message:{message_id:3,from:{id:user,is_bot:false},chat:{id:user,type:'private'},audio:{file_id:'invalid',duration:-1,file_size:4}}});assert.equal((await bot.readVoice(id)).available,true);
  now+=3600001;assert.equal((await bot.readVoice(id)).available,false);await assert.rejects(bot.readVoice(id,true),/устарело/);assert.equal(downloads,1);
});

test('long-session analysis parts are assembled only from matching server-held fragment hashes',async t=>{
  const f=fixture(t),args={sessionId:'owner',scope:'psychiatrist',patientId:'anna'},c=await f.run(args);
  const next=rows.map((r,i)=>({...r,id:'s'+(i+2),text:r.text+' Второй фрагмент.'}));
  for(const fragments of [rows,next]){await f.run({...args,action:{op:'analyze',episodeId:c.episodeId,sourceRevision:c.sourceRevision,segments:fragments,synthetic:true,participantsConsent:true,aiConsent:true}});f.advance();}
  const combined=await f.run({...args,action:{op:'save',episodeId:c.episodeId,sourceRevision:c.sourceRevision,segments:[...rows,...next],title:'Беседа по частям',duration:30,synthetic:true,participantsConsent:true,reviewed:true}});
  assert.equal(combined.notes[0].ai.complete,true);assert.equal(combined.notes[0].ai.parts,2);assert.equal(combined.notes[0].segments.every(r=>r.topics.length>0),true);assert.equal(f.calls,2);
});
test('VOP checklist changes cannot reuse an analysis prepared for other observations',async t=>{
  const f=fixture(t),args={sessionId:'owner',scope:'vop'},c=await f.run(args);
  const base={episodeId:c.episodeId,sourceRevision:c.sourceRevision,segments:rows,synthetic:true,participantsConsent:true};
  const ai=await f.run({...args,action:{...base,op:'analyze',aiConsent:true,vopContext:{observations:['sleep'],safety:[]}}});assert.ok(ai.analysis.clinicalFacts.some(f=>f.id==='vop-observation-sleep'));
  const result=await f.run({...args,action:{...base,op:'save',reviewed:true,title:'Беседа ВОП',duration:9,vopContext:{observations:['worry'],safety:['current-danger']}}});
  const note=result.notes[0];assert.equal(note.ai,null);assert.ok(note.vopObservations.includes('Частое беспокойство'));assert.equal(note.vopSafety.length,1);assert.equal(note.segments.every(r=>r.topics.length===0),true);assert.equal(f.store.get('owner').voiceNotes,undefined);
});

test('speech assets are allowlisted and hash checked before serving executable model code',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'voice-assets-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0;
  const assets=createVoiceAssets({cacheDirectory:dir,fetchImpl:async()=>{calls++;return new Response('unexpected content')}});
  assert.equal(await assets('../../outside'),null);assert.equal(calls,0);
  await assert.rejects(assets('whisper-base/config.json'),/проверить речевой модуль/);assert.equal(calls,1);
});

test('audio processor enforces sample limit independently of browser timers and stops on pause',async()=>{
  const oldBase=globalThis.AudioWorkletProcessor,oldRegister=globalThis.registerProcessor,oldRate=globalThis.sampleRate;let Processor;const events=[];
  try{
    globalThis.AudioWorkletProcessor=class{constructor(){this.port={postMessage:e=>events.push(e)}}};globalThis.registerProcessor=(name,p)=>{Processor=p};globalThis.sampleRate=48000;
    await import('../public/shared/voice-audio-worklet.js');const processor=new Processor({processorOptions:{maximumSeconds:2}}),frame=new Float32Array(128).fill(0.4);
    for(let i=0;i<100;i++)processor.process([[frame]]);const count=processor.total;processor.port.onmessage({data:'pause'});for(let i=0;i<100;i++)processor.process([[frame]]);assert.equal(processor.total,count);
    processor.port.onmessage({data:'resume'});for(let i=0;i<2000;i++)processor.process([[frame]]);
    assert.equal(processor.total,32000);assert.equal(events.filter(e=>e.type==='limit').length,1);assert.ok(events.filter(e=>e.type==='level').length>=3);assert.ok(events.filter(e=>e.type==='level').every(e=>Math.abs(e.value-0.4)<0.001));assert.equal(events.filter(e=>e.audio).reduce((sum,e)=>sum+e.audio.length,0),32000);
    processor.port.onmessage({data:'resume'});processor.process([[frame]]);assert.equal(processor.total,32000);
  }finally{globalThis.AudioWorkletProcessor=oldBase;globalThis.registerProcessor=oldRegister;globalThis.sampleRate=oldRate;}
});
test('closing a recording while microphone permission is pending cannot start a hidden capture after permission arrives',async()=>{
  const keys=['navigator','window','AudioContext'],descriptors=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));let resolveMedia,stopped=0,closed=0,worklets=0;
  try{
    const media=new Promise(resolve=>{resolveMedia=resolve});
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>media}}});
    Object.defineProperty(globalThis,'window',{configurable:true,value:{MediaRecorder:class{},AudioWorkletNode:class{}}});
    Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:class{state='suspended';audioWorklet={addModule:()=>{worklets++;return Promise.resolve()}};resume(){this.state='running';return Promise.resolve()}close(){closed++;this.state='closed';return Promise.resolve()}}});
    const abort=new AbortController(),task=startVoiceCapture({onChunk:()=>{},onState:()=>{},signal:abort.signal});abort.abort();
    await assert.rejects(task,{name:'AbortError'});assert.equal(closed,1);assert.equal(worklets,0);
    resolveMedia({getTracks:()=>[{stop:()=>{stopped++}}]});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,1);
  }finally{for(const key of keys){const d=descriptors.get(key);if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}}
});
test('microphone timeout releases the audio context and stops any stream granted after the timeout',async()=>{
  const keys=['navigator','window','AudioContext'],descriptors=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));let resolveMedia,stopped=0,closed=0,resumedBeforeMedia=false;
  try{
    const media=new Promise(resolve=>{resolveMedia=resolve});
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:constraints=>{assert.equal(resumedBeforeMedia,true);assert.deepEqual(constraints.audio.deviceId,{exact:'synthetic-microphone'});return media}}}});
    Object.defineProperty(globalThis,'window',{configurable:true,value:{MediaRecorder:class{},AudioWorkletNode:class{}}});
    Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:class{state='suspended';resume(){resumedBeforeMedia=true;return Promise.resolve()}close(){closed++;this.state='closed';return Promise.resolve()}}});
    await assert.rejects(startVoiceCapture({onChunk:()=>{},onState:()=>{},deviceId:'synthetic-microphone',setupTimeoutMs:10}),/не завершил запрос микрофона/);assert.equal(closed,1);
    resolveMedia({getTracks:()=>[{stop:()=>{stopped++}}]});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,1);
  }finally{for(const key of keys){const d=descriptors.get(key);if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}}
});
test('cancellation during worklet loading releases the microphone without starting a recorder',async()=>{
  const keys=['navigator','window','AudioContext'],descriptors=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));let resolveWorklet,stopped=0,closed=0;const phases=[];
  try{
    const worklet=new Promise(resolve=>{resolveWorklet=resolve});
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>{stopped++}}]})}}});
    Object.defineProperty(globalThis,'window',{configurable:true,value:{MediaRecorder:class{},AudioWorkletNode:class{}}});
    Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:class{state='running';audioWorklet={addModule:()=>worklet};resume(){return Promise.resolve()}close(){closed++;this.state='closed';return Promise.resolve()}}});
    const abort=new AbortController(),task=startVoiceCapture({onChunk:()=>{},onState:()=>{},onSetup:p=>phases.push(p),signal:abort.signal});
    await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(phases,['permission','processor']);abort.abort();await assert.rejects(task,{name:'AbortError'});assert.equal(closed,1);assert.ok(stopped>=1);resolveWorklet();
  }finally{for(const key of keys){const d=descriptors.get(key);if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}}
});

test('voice summary keeps complete source quotes, attribution and an explicit count of omitted fragments',()=>{
 const segments=[{id:'s0',role:'doctor',text:'Вы начали принимать препарат?',topics:['medicines']},{id:'s1',role:'patient',text:'Я НЕ принимаю лекарства.',topics:['medicines','history']},{id:'s2',role:'patient',text:'Не сплю вторую неделю.',topics:['sleep','complaints']},{id:'s3',role:'doctor',text:'Давайте обсудим следующий контакт.',topics:['plan']},{id:'s4',role:'unknown',text:'Неясно, кто это сказал.',topics:['other']}];
 const summary=voiceSummary(segments,3);assert.deepEqual(summary.segments.map(s=>s.id),['s2','s1','s3']);assert.equal(summary.omitted,2);assert.equal(summary.segments[1].text,'Я НЕ принимаю лекарства.');assert.equal(summary.segments[2].role,'doctor');assert.deepEqual(voiceSummary([]),{segments:[],omitted:0});assert.equal(voiceSummary([segments[1],{...segments[1],id:'s5'}]).segments.length,1);
});

test('quiet audio above the noise gate reaches recognition without changing the original recording or clipping',()=>{
 const quiet=Float32Array.from({length:16000},(_,i)=>0.001*Math.sin(i/10)),before=quiet.slice(),prepared=prepareVoiceAudio(quiet);assert.ok(prepared);assert.deepEqual(quiet,before);assert.ok(Math.max(...prepared)>0.01);assert.ok(Math.max(...prepared)<=0.95);assert.equal(prepareVoiceAudio(new Float32Array(16000)),null);assert.equal(prepareVoiceAudio(new Float32Array()),null);const loud=new Float32Array([0.9,-0.9]);assert.equal(prepareVoiceAudio(loud),loud);
});

test('model download retries one transient network failure, never a memory or runtime error',async()=>{
 const {loadVoiceModel}=await import('../public/shared/voice-model-loader.js');let calls=0,retries=0;const options={delay:async()=>{},onRetry:()=>{retries++}};
 const value=await loadVoiceModel(async()=>{if(++calls===1)throw new TypeError('Failed to fetch');return 'ready'},options);assert.equal(value,'ready');assert.equal(calls,2);assert.equal(retries,1);
 calls=0;await assert.rejects(loadVoiceModel(async()=>{calls++;throw new RangeError('memory allocation failed')},options),/memory/);assert.equal(calls,1);
 calls=0;await assert.rejects(loadVoiceModel(async()=>{calls++;throw new TypeError('NetworkError')},options),/Network/);assert.equal(calls,2);
});
