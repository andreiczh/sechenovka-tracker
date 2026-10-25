import test from 'node:test';
import assert from 'node:assert/strict';
import {createPatient,createHistory} from '../lib/patient.mjs';
import {visitPreparation,patientVoiceOptions,patientHelpState} from '../public/patient/patient-model.js';
test('preparation is immediately useful without completed forms and never invents scores',()=>{
 const s=createPatient();s.active={values:{'phq-0':3}};
 const v=visitPreparation(s);assert.equal(v.scores,null);assert.equal(v.complete,false);
 assert.match(v.opening,/Анкеты пока не завершены/);assert.doesNotMatch(v.opening,/PHQ-9 — \d|диагноз/);
 assert.ok(v.questions.some(q=>q.id==='contact'));
});
test('preparation uses saved results and the latest explicit patient question',()=>{
 const s=createHistory();s.appointment.question='Хочу обсудить сон';
 const v=visitPreparation(s);assert.equal(v.scores.phq.score,12);assert.equal(v.scores.gad.score,10);
 assert.match(v.opening,/Хочу обсудить сон/);assert.ok(v.questions.some(q=>q.id==='sleep'));
 const before=JSON.stringify(s);visitPreparation(s);assert.equal(JSON.stringify(s),before);
});
test('safety comes before ordinary preparation without converting it to a numeric risk',()=>{
 const s=createPatient();s.safety={pending:true};
 assert.equal(visitPreparation(s).questions[0].id,'safety');
});
test('a patient recording can reuse onboarding consent but opening a saved note or Telegram audio never starts the microphone',()=>{
 const s={joined:true};assert.equal(patientVoiceOptions(s).autoRecord,true);
 assert.equal(patientVoiceOptions(s).syntheticConfirmed,true);
 for(const extra of [{existing:{}},{library:true},{inbox:true},{autoRecord:false}])assert.equal(patientVoiceOptions(s,extra).autoRecord,false);
 assert.equal(patientVoiceOptions({joined:false}).syntheticConfirmed,false);
});
test('compact help preserves every safety state and never mutates an unfinished answer',()=>{
 const s=createPatient();assert.equal(patientHelpState(s).flagged,false);
 for(const level of ['urgent','unknown']){
  s.safety={level,pending:false,needsGuidance:false};
  const v=patientHelpState(s);assert.equal(v.critical,true);assert.equal(v.flagged,true);assert.match(v.title,/112/);
 }
 s.safety={level:null,pending:true,source:'PHQ-9, пункт 9'};s.active={values:{'phq-8':1}};
 const before=JSON.stringify(s),v=patientHelpState(s);
 assert.equal(v.pending,true);assert.equal(v.critical,false);assert.equal(v.flagged,true);
 assert.equal(JSON.stringify(s),before);
 s.safety={level:'contact',pending:false};assert.equal(patientHelpState(s).critical,false);assert.equal(patientHelpState(s).flagged,true);
 s.safety={needsGuidance:true};assert.equal(patientHelpState(s).critical,true);
});
