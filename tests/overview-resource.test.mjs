import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewModel, meetingQuestions } from '../public/psychiatrist/overview-model.js';
import { RESOURCE_SCENARIOS, resourceEstimate, patientWorkload } from '../lib/resource-model.mjs';

const profile=()=>({assessments:[],delta:{phq:null,gad:null},diary:[],safety:{phq9:null,needsClarification:true},support:{questions:[{id:'function',text:'ignored'}]}});

test('overview distinguishes absent questionnaires from true zero scores and retains pending safety',()=>{
  const p=profile();let m=overviewModel(p);
  assert.deepEqual(m.scores.map(s=>s.value),[null,null]);assert.equal(m.safetyAnswer,null);assert.equal(m.safetyNeedsClarification,true);
  p.assessments.push({date:'2026-10-24',scores:{phq:{complete:true,score:0},gad:{complete:true,score:0}}});p.delta={phq:0,gad:0};p.safety.phq9=0;
  m=overviewModel(p);assert.deepEqual(m.scores.map(s=>s.value),[0,0]);assert.deepEqual(m.scores.map(s=>s.delta),[0,0]);assert.equal(m.safetyAnswer,0);assert.equal(m.safetyNeedsClarification,true);
});
test('meeting questions share the clinical catalogue; function burden uses counts, not ordinal averages',()=>{
  const p=profile();p.day=4;p.diary=[{day:0,function:0},{day:1,function:1},{day:2,function:2},{day:3,function:3},{day:4,function:null},{day:5,function:3},{day:15,function:3}];
  const m=overviewModel(p);assert.equal(m.functionDifficult,2);
  assert.equal(m.recordCount,5);assert.equal(m.lastDiary.day,4);
  assert.equal(meetingQuestions(p)[0].id,'current-safety');assert.match(meetingQuestions(p)[1].text,/конкретный пример/);
});
test('resource model includes attrition, review, EHR copying, support and training without hidden double counting',()=>{
  const m=resourceEstimate();assert.equal(m.completed,75);assert.equal(m.usedVisits,36);assert.ok(Math.abs(m.repeats-21.6)<1e-9);
  assert.ok(Math.abs(m.netMinutes-160.45)<1e-9);assert.ok(Math.abs(m.physicianMinutes-170.45)<1e-9);assert.equal(m.coordinatorMinutes,-10);
  assert.equal(m.rows.find(r=>r.id==='documentation').netMinutes,18);
  assert.equal(m.rows.find(r=>r.id==='ehr-copy').netMinutes,-36);
  assert.equal(resourceEstimate(RESOURCE_SCENARIOS.base,0).netMinutes,0);
  assert.ok(resourceEstimate(RESOURCE_SCENARIOS.conservative).netMinutes<0);
  assert.ok(resourceEstimate({...RESOURCE_SCENARIOS.base,scaleBefore:1.25,repeatBefore:1}).netMinutes<0);
  assert.throws(()=>resourceEstimate({...RESOURCE_SCENARIOS.base,completion:1.2}),RangeError);
});
test('patient labour is reported as added monitoring work, never as unsupported time saved',()=>{
  const m=patientWorkload();assert.equal(m.diaryEntries,600);assert.ok(Math.abs(m.addedMinutes-620)<1e-9);
  const full=patientWorkload({offered:1,completed:1,usedVisits:1,repeats:1,diaryDays:14});
  assert.equal(full.before,19);assert.equal(full.after,30);assert.equal(full.addedMinutes,11);
});
