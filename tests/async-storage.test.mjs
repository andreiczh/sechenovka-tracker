import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readConfig } from '../lib/config.mjs';
import { createStore } from '../lib/store.mjs';
import { createAppServer } from '../server.mjs';

test('Render chooses a verified PostgreSQL connection and its own HTTPS origin, without a local persistent disk',()=>{
  const config=readConfig({NODE_ENV:'production',DEMO_MODE:'true',RENDER:'true',RENDER_EXTERNAL_URL:'https://fixture.onrender.com',DATABASE_URL:'postgresql://fixture:fixture-only@fixture.neon.tech/neondb?sslmode=require',REMINDER_SCHEDULER:'off'});
  assert.equal(config.storage,'postgres');assert.equal(config.publicOrigin,'https://fixture.onrender.com');assert.equal(config.host,'0.0.0.0');
  for(const DATABASE_URL of ['https://fixture.invalid','postgresql://fixture@fixture.neon.tech/neondb','postgresql://fixture:fixture-only@fixture.neon.tech/neondb?sslmode=disable'])assert.throws(()=>readConfig({DATABASE_URL}));
});

test('async session operations serialize one owner while other owners remain independent',async()=>{
  const store=createStore(':memory:');store.save('a',{value:0});store.save('b',{value:0});
  let unlock;const held=new Promise(resolve=>{unlock=resolve});const events=[];
  const first=store.withSession('a',async t=>{const a=t.get('a');events.push('a1');await held;a.value++;t.save('a',a);});
  const second=store.withSession('a',async t=>{const a=t.get('a');events.push('a2');a.value++;t.save('a',a);});
  await store.withSession('b',async t=>{events.push('b');const b=t.get('b');b.value++;t.save('b',b);});
  assert.deepEqual(events,['a1','b']);unlock();await Promise.all([first,second]);assert.equal(store.get('a').value,2);assert.equal(store.get('b').value,1);store.close();
});

test('HTTP success is sent only after durable commit; a failed commit returns an error and retains the old state',async()=>{
  let rows=new Map(), failCommit=false, releaseCommit, gate=Promise.resolve();
  const storage={ready:Promise.resolve(),close(){},all:()=>[],async withSession(id,callback){
    const staged=structuredClone(rows);
    const result=await callback({get:k=>staged.get(k)||null,save:(k,v)=>staged.set(k,v),getWorkspace:()=>null,saveWorkspace(){}});
    await gate;if(failCommit)throw new Error('simulated durable commit failure');rows=staged;return result;
  }};
  const server=createAppServer({storage,config:readConfig({}),logger:()=>{}});server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    const initial=await fetch(origin+'/api/state'),cookie=initial.headers.get('set-cookie').split(';')[0],state=await initial.json();
    gate=new Promise(resolve=>{releaseCommit=resolve});let acknowledged=false;
    const pending=fetch(origin+'/api/action',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Demo-Client':'1'},body:JSON.stringify({type:'join',adult:true,revision:state.revision})}).then(r=>{acknowledged=true;return r;});
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(acknowledged,false);releaseCommit();const saved=await pending;assert.equal(saved.status,200);const next=await saved.json();
    failCommit=true;
    const failed=await fetch(origin+'/api/action',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Demo-Client':'1'},body:JSON.stringify({type:'start',revision:next.revision})});assert.equal(failed.status,500);
    failCommit=false;gate=Promise.resolve();const after=await(await fetch(origin+'/api/state',{headers:{Cookie:cookie}})).json();assert.equal(after.revision,next.revision);assert.equal(after.active,null);
  }finally{server.close();await once(server,'close');}
});
