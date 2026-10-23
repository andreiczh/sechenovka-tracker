import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatient, createHistory, applyAction } from '../lib/patient.mjs';
import { createClinicianWorkspace, clinicianPatient, clinicianList, saveClinicalReview, patientCarePlan } from '../lib/clinician.mjs';

const NOW = Date.parse('2026-10-23T10:00:00Z');
const setup = () => ({ workspace: createClinicianWorkspace(NOW), live: createPatient(NOW) });
const values = { clinicalNote: 'Внутренняя клиническая запись', safetyNote: 'Результат отдельной беседы и согласованные действия', goal: 'Лучше спать', plan: 'Согласованный план наблюдения', watch: 'Сон и обычные дела', earlyContact: 'При ухудшении связаться раньше по согласованному каналу', nextDate: '2026-11-01', nextTime: '12:30' };
function action(workspace, live, id, type, extra = {}) {
  const p = clinicianPatient(workspace, id, live, NOW);
  return saveClinicalReview(workspace, id, live, { type, revision: p.review.revision, sourceRevision: p.sourceRevision, episodeId: p.episodeId, values, reviewed: true, ...extra }, NOW);
}

test('clinician fixtures expose reproducible independent scores, honest missing values and denominators', () => {
  const { workspace, live } = setup();
  const anna = clinicianPatient(workspace, 'anna', live, NOW);
  assert.deepEqual(anna.assessments.map(a => [a.scores.phq.score,a.scores.gad.score]), [[12,10],[7,6]]);
  assert.deepEqual(anna.delta, {phq:-5,gad:-4});
  assert.equal(anna.stats.recorded,11); assert.equal(anna.stats.expected,14); assert.equal(anna.stats.missing,3);
  assert.equal(anna.stats.sleepCount,9);
  assert.equal(anna.weeks.reduce((s,w)=>s+w.recorded,0),11);
  assert.equal(anna.days.find(d=>d.day===4).entry,null);
  const olga=clinicianPatient(workspace,'olga',live,NOW);
  assert.equal(olga.daysAgo,8); assert.equal(olga.days.find(d=>d.day===14).future,true);
  assert.equal(olga.stats.expected,13); assert.equal(olga.stats.recorded,3);
  assert.equal(olga.diary[0].retrospective,true);
  assert.equal(clinicianList(workspace,live,NOW).length,6);
});

test('an unfinished scale is a draft, unknown answers stay null and no diagnostic score is invented', () => {
  const {workspace,live}=setup(),p=clinicianPatient(workspace,'egor',live,NOW);
  assert.equal(p.assessments.length,0);assert.equal(p.draft.scores.phq.answered,8);assert.equal(p.draft.scores.phq.score,null);
  assert.equal(p.draft.scores.gad.answered,0);assert.equal(p.draft.answers[8],null);
  assert.equal(p.stats.expected,0);assert.equal(p.delta.phq,null);
  assert.match(p.summary,/черновик, пропуски не считаются нулём/);
});

test('true zero and missing sleep stay different in daily and weekly aggregation, including day 0', () => {
  const {workspace}=setup(),live=createHistory(NOW);
  live.diary[0].mood=0;live.diary[0].anxiety=0;live.diary[0].sleep=0;
  live.diary[1].sleep=null;
  const p=clinicianPatient(workspace,'live',live,NOW);
  assert.equal(p.diary[0].sleep,0);assert.equal(p.diary[1].sleep,null);
  const rows=live.diary.filter(e=>e.day>=1&&e.day<=7),valid=rows.filter(e=>Number.isFinite(e.sleep));
  assert.equal(p.weeks[0].sleepCount,valid.length);
  assert.equal(p.weeks[0].sleep,Math.round(valid.reduce((s,e)=>s+e.sleep,0)/valid.length*10)/10);
});

test('reading a safety response never clears raw concern; confirmation requires a separate note', () => {
  const {workspace,live}=setup();
  const p=clinicianPatient(workspace,'mikhail',live,NOW);
  assert.equal(p.safety.phq9,1);assert.equal(p.safety.events[0].level,'contact');assert.equal(p.safety.needsClarification,true);
  assert.equal(action(workspace,live,'mikhail','viewed').status,200);
  assert.equal(clinicianPatient(workspace,'mikhail',live,NOW).safety.needsClarification,true);
  assert.equal(action(workspace,live,'mikhail','confirm',{values:{...values,safetyNote:''}}).status,400);
  assert.equal(action(workspace,live,'mikhail','confirm').status,200);
  const after=clinicianPatient(workspace,'mikhail',live,NOW);
  assert.equal(after.safety.phq9,1);assert.equal(after.safety.needsClarification,true);assert.match(after.safety.currentAssessment,/Есть запись врача/);
  assert.equal(after.review.history.length,1);
});

test('drafts never reach a patient; confirmed plan strips internal fields and belongs to one episode', () => {
  const {workspace,live}=setup();
  live.appointment = { ...live.appointment, date: '2026-10-25', time: '15:00', question: 'Мой вопрос' };
  assert.equal(clinicianPatient(workspace,'live',live,NOW).appointment.confirmed,false);
  assert.equal(action(workspace,live,'live','draft').status,200);assert.equal(patientCarePlan(workspace,live),null);
  assert.equal(action(workspace,live,'live','confirm').status,200);
  const plan=patientCarePlan(workspace,live);assert.equal(plan.goal,values.goal);
  const appointment = clinicianPatient(workspace,'live',live,NOW).appointment;
  assert.equal(appointment.confirmed,true); assert.equal(appointment.date,values.nextDate); assert.equal(appointment.time,values.nextTime);
  assert.equal(appointment.reportedDate,'2026-10-25'); assert.equal(appointment.question,'Мой вопрос'); assert.equal(live.appointment.date,'2026-10-25');
  assert.equal(plan.clinicalNote,undefined);assert.equal(plan.safetyNote,undefined);assert.equal(plan.sourceRevision,undefined);
  assert.equal(patientCarePlan(workspace,createPatient(NOW)),null);
  assert.equal(patientCarePlan(workspace,createHistory(NOW)),null);
});

test('stale doctor revisions and stale patient data cannot overwrite or confirm a plan', () => {
  const {workspace,live}=setup();const before=clinicianPatient(workspace,'live',live,NOW);
  assert.equal(action(workspace,live,'live','draft').status,200);
  assert.equal(saveClinicalReview(workspace,'live',live,{type:'draft',values,episodeId:before.episodeId,revision:before.review.revision},NOW).status,409);
  const updated=applyAction(structuredClone(live),{type:'join',adult:true},NOW);updated.revision++;
  const p=clinicianPatient(workspace,'live',updated,NOW);
  assert.equal(saveClinicalReview(workspace,'live',updated,{type:'confirm',values,reviewed:true,episodeId:p.episodeId,revision:p.review.revision,sourceRevision:before.sourceRevision},NOW).status,409);
  assert.equal(patientCarePlan(workspace,updated),null);
});

test('invalid, impossible and past dates, missing fields, long text and absent confirmation are rejected', () => {
  for(const override of [{nextDate:'2026-02-30'},{nextDate:'2020-01-01'},{nextTime:'24:01'},{plan:''},{clinicalNote:'x'.repeat(2001)}]){
    const {workspace,live}=setup();assert.equal(action(workspace,live,'anna','confirm',{values:{...values,...override}}).status,400);assert.deepEqual(workspace.reviews,{});
  }
  const {workspace,live}=setup();assert.equal(action(workspace,live,'anna','confirm',{reviewed:false}).status,400);
  assert.equal(saveClinicalReview(workspace,'absent',live,{},NOW).status,404);
});

test('new data preserves the prior confirmed version; adherence unknown is not a missed dose', () => {
  const {workspace,live}=setup();assert.equal(action(workspace,live,'irina','confirm').status,200);
  const p=clinicianPatient(workspace,'irina',live,NOW);assert.equal(p.adherence.taken,8);assert.equal(p.adherence.missed,2);assert.equal(p.adherence.unknown,4);
  assert.equal(p.medications.every(m=>m.verified===false),true);assert.match(p.adherence.reason,/не заданы/);
  workspace.patients.find(p=>p.id==='irina').state.revision++;
  const after=clinicianPatient(workspace,'irina',live,NOW);
  assert.equal(after.dataChangedSinceReview,true);assert.equal(after.review.history.length,1);
  assert.equal(after.review.confirmed.id,p.review.confirmed.id);
});
