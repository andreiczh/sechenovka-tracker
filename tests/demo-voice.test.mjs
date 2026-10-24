import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createClinicianWorkspace,clinicianPatient} from '../lib/clinician.mjs';
import {createPatient} from '../lib/patient.mjs';
import {ensureDemoVoiceHistory,DEMO_VOICE_SCENARIOS} from '../lib/demo-voices.mjs';
import {demoAudioPath,voiceText} from '../public/shared/voice-model.js';
import {initialWorkspaceMode} from '../public/psychiatrist/overview-model.js';
import {once} from 'node:events';
import {createAppServer} from '../server.mjs';
import {createStore} from '../lib/store.mjs';
import {readConfig} from '../lib/config.mjs';
const NOW=Date.parse('2026-10-24T10:00:00Z');

test('cabinet starts with ready profiles even with an active login; connected deep links remain protected',()=>{
  assert.equal(initialWorkspaceMode({enabled:true,authenticated:true}),'demo');
  assert.equal(initialWorkspaceMode({enabled:true,authenticated:false}),'demo');
  assert.equal(initialWorkspaceMode({enabled:true},'anna'),'demo');
  assert.equal(initialWorkspaceMode({enabled:true,authenticated:false},'care-own-profile'),'clinic');
  assert.equal(initialWorkspaceMode({enabled:false},'care-own-profile'),'demo');
});
test('each ready profile has its own scripted patient note and doctor dialogue without diagnosing or clearing safety',()=>{
  const workspace=createClinicianWorkspace(NOW),live=createPatient(NOW);
  for(const id of Object.keys(DEMO_VOICE_SCENARIOS)){
    const p=clinicianPatient(workspace,id,live,NOW);
    assert.equal(p.voiceNotes.length,2);assert.deepEqual(new Set(p.voiceNotes.map(n=>n.scope)),new Set(['patient','psychiatrist']));
    for(const note of p.voiceNotes){assert.equal(note.episodeId,p.episodeId);assert.equal(note.ai,null);assert.equal(note.example.method,'scripted-speech');assert.ok(demoAudioPath(note));assert.match(voiceText(note),/это не результат распознавания/);}
  }
  assert.equal(clinicianPatient(workspace,'olga',live,NOW).daysAgo,8);
  assert.equal(clinicianPatient(workspace,'egor',live,NOW).assessments.length,0);
  assert.equal(clinicianPatient(workspace,'mikhail',live,NOW).safety.needsClarification,true);
});
test('example migration is idempotent, preserves archives and plans, and never touches connected workspaces',()=>{
  const workspace=createClinicianWorkspace(NOW);delete workspace.demoVoiceVersion;
  const entry=workspace.patients[0],key=`anna:${entry.state.episodeId}`;
  workspace.voices[key][0].archivedAt='2026-10-24T09:00:00Z';workspace.reviews.marker={text:'PRIVATE-PRESERVED'};
  const before=JSON.stringify(workspace);assert.equal(ensureDemoVoiceHistory(workspace),false);delete workspace.demoVoiceVersion;assert.equal(JSON.stringify(workspace),before);
  const connected={patients:[],reviews:{private:true}};const frozen=JSON.stringify(connected);assert.equal(ensureDemoVoiceHistory(connected),false);assert.equal(JSON.stringify(connected),frozen);
  assert.equal(demoAudioPath({synthetic:true,example:{version:1,method:'scripted-speech',audioPath:'https://example.com/voice.wav'}}),null);
});
test('all ten public demo recordings are nonempty PCM WAVs with timing aligned to the prepared transcript',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../public/assets/demo-voice/manifest.json',import.meta.url)));
  assert.equal(Object.keys(manifest).length,10);
  for(const [name,asset] of Object.entries(manifest)){
    const audio=await readFile(new URL(`../public/assets/demo-voice/${name}.wav`,import.meta.url));
    assert.equal(audio.toString('ascii',0,4),'RIFF');assert.equal(audio.readUInt32LE(24),16000);assert.ok(audio.length>32000);
    assert.ok(Math.abs((audio.length-44)/32000-asset.duration)<1e-6);
    assert.ok(asset.segments.length>=2);assert.ok(asset.segments.every(s=>s.end>s.start&&s.end<=asset.duration));
    assert.ok(audio.subarray(44).some(byte=>byte!==0));
  }
});
test('public synthetic audio supports metadata and byte ranges for Safari playback without exposing private recordings',async t=>{
  const store=createStore(':memory:');const server=createAppServer({config:readConfig({REMINDER_SCHEDULER:'off'}),storage:store,logger:()=>{}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.close();await once(server,'close');});
  const url=`http://127.0.0.1:${server.address().port}/assets/demo-voice/anna-session.wav`;
  const r=await fetch(url,{headers:{Range:'bytes=0-43'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-type'),'audio/wav');assert.equal(r.headers.get('accept-ranges'),'bytes');assert.match(r.headers.get('content-range'),/^bytes 0-43\//);assert.equal((await r.arrayBuffer()).byteLength,44);
  const tail=await fetch(url,{headers:{Range:'bytes=-100'}});assert.equal(tail.status,206);assert.equal((await tail.arrayBuffer()).byteLength,100);
  assert.equal((await fetch(url,{headers:{Range:'bytes=999999999999-'}})).status,416);
  assert.equal((await fetch(url,{headers:{Range:'bytes=-0'}})).status,416);
});
