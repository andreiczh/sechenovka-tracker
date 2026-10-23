import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';

test('clinician API isolates demo workspaces, persists drafts, protects revisions and shares only a confirmed episode plan', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sechenovka-clinician-')),storePath=join(dir,'demo.sqlite');let server,origin;
  const errors=[];const start=async()=>{server=createAppServer({config:readConfig({}),storePath,wallClock:()=>Date.parse('2026-10-23T10:00:00Z'),logger:e=>errors.push(e)});server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`;};
  const stop=async()=>{server.close();await once(server,'close');};
  const call=async(path,{cookie,body,originHeader}={})=>{
    const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json','X-Demo-Client':'1'}:{}),...(originHeader?{Origin:originHeader}:{})},body:body?JSON.stringify(body):undefined});
    return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],data:await r.json()};
  };
  const values={clinicalNote:'PRIVATE-CLINICAL',safetyNote:'PRIVATE-SAFETY',goal:'Личная цель',plan:'План',watch:'Наблюдение',earlyContact:'Контакт раньше',nextDate:'2026-11-01',nextTime:'14:00'};
  try{
    await start();assert.equal((await fetch(origin+'/psychiatrist/')).status,200);
    const a=await call('/api/clinician/patients'),b=await call('/api/clinician/patients');assert.equal(a.data.patients.length,6);assert.notEqual(a.cookie,b.cookie);
    const get=(id,cookie=a.cookie)=>call('/api/clinician/patients/'+id,{cookie});
    const initial=(await get('live')).data;
    const write=(p,type,extra={})=>call('/api/clinician/patients/live/review',{cookie:a.cookie,body:{type,revision:p.review.revision,sourceRevision:p.sourceRevision,episodeId:p.episodeId,values,reviewed:true,...extra}});
    const draft=await write(initial,'draft');assert.equal(draft.status,200);assert.equal((await call('/api/state',{cookie:a.cookie})).data.carePlan,null);
    assert.equal((await get('live',b.cookie)).data.review.draft,null);
    assert.equal((await write(initial,'draft')).status,409);
    assert.equal((await get('not-a-patient')).status,404);
    assert.equal((await call('/api/clinician/patients',{cookie:a.cookie,originHeader:'https://evil.example'})).status,403);
    assert.equal((await call('/api/clinician/patients/live/events',{cookie:a.cookie,body:{view:'diagnose',sourceRevision:initial.sourceRevision}})).status,400);
    assert.equal((await call('/api/clinician/patients/live/events',{cookie:a.cookie,body:{view:'overview',sourceRevision:initial.sourceRevision}})).status,200);
    await stop();await start();
    const persisted=(await get('live')).data;assert.equal(persisted.review.draft.clinicalNote,'PRIVATE-CLINICAL');assert.ok(persisted.activity.some(e=>e.event==='view-presented'));
    let patient=(await call('/api/state',{cookie:a.cookie})).data;
    const join=await call('/api/action',{cookie:a.cookie,body:{type:'join',adult:true,revision:patient.revision}});assert.equal(join.status,200);patient=join.data;
    assert.equal((await write(persisted,'confirm')).status,409);
    const current=(await get('live')).data;const confirmed=await write(current,'confirm');assert.equal(confirmed.status,200);
    const shared=(await call('/api/state',{cookie:a.cookie})).data;assert.equal(shared.carePlan.goal,'Личная цель');assert.doesNotMatch(JSON.stringify(shared),/PRIVATE-CLINICAL|PRIVATE-SAFETY/);
    assert.equal((await call('/api/state',{cookie:b.cookie})).data.carePlan,null);
    const confirmedId=shared.carePlan.id;
    await stop();await start();assert.equal((await call('/api/state',{cookie:a.cookie})).data.carePlan.id,confirmedId);
    const reset=await call('/api/action',{cookie:a.cookie,body:{type:'reset',revision:shared.revision}});assert.equal(reset.status,200);assert.equal(reset.data.carePlan,null);assert.equal((await get('live')).data.review.confirmed,null);
    assert.doesNotMatch(JSON.stringify(errors),/PRIVATE-|sechenovka_demo|Cookie/);
  }finally{if(server?.listening)await stop();await rm(dir,{recursive:true,force:true});}
});
