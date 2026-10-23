import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import { createPostgresStore } from '../lib/postgres-store.mjs';
import { createAppServer } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { emptyTherapyContext } from '../lib/therapy-support.mjs';

// Explicit opt-in: regular CI must never read or change the deployment database.
test('PostgreSQL: verified TLS, rollback, concurrent servers and durable patient/doctor records', { skip: process.env.RUN_POSTGRES_TESTS !== '1' }, async t => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'DATABASE_URL is required for the opt-in integration check');
  const owner = randomUUID(), row = randomUUID();
  const clinicKey = randomBytes(32).toString('hex'), authOwners = [];
  const first = createPostgresStore(databaseUrl);
  await first.ready;
  const second = createPostgresStore(databaseUrl);
  await second.ready;
  let servers = [];
  const start = async () => {
    const server = createAppServer({ config: readConfig({ DATABASE_URL: databaseUrl, REMINDER_SCHEDULER: 'off', CLINICIAN_ACCESS_KEY: clinicKey }), logger: () => {} });
    await server.ready;
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { await Promise.all(servers.map(async server => { server.close(); await once(server, 'close'); })); servers = []; };
  const call = async (origin, path, body, cookie = `sechenovka_demo=${owner}`) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json', 'X-Demo-Client': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    await first.withSession(row, t => t.save(row, { count: 0 }));
    await assert.rejects(first.withSession(row, async t => { await t.save(row, { count: 999 }); throw new Error('fixture rollback'); }), /fixture rollback/);
    assert.equal(await second.withSession(row, async t => (await t.get(row)).count), 0);
    await first.withSession(row, t => t.saveTelegram(row, { outbox: [{ status: 'pending', id: 'synthetic-message' }], seen: [1] }));
    assert.equal((await second.withSession(row, t => t.getTelegram(row))).outbox[0].status, 'pending');
    await assert.rejects(first.withSession(row, async t => { await t.saveTelegram(row, { outbox: [] }); throw new Error('telegram rollback'); }), /telegram rollback/);
    assert.equal((await second.withSession(row, t => t.getTelegram(row))).outbox.length, 1);
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).withSession(row, async t => { const value = await t.get(row); value.count++; await t.save(row, value); })));
    assert.equal(await first.withSession(row, async t => (await t.get(row)).count), 8);
    const a = await start(), b = await start();
    const initial = (await call(a, '/api/state')).data;
    const concurrent = await Promise.all([a, b].map(origin => call(origin, '/api/action', { type: 'join', adult: true, revision: initial.revision })));
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
    const current = (await call(a, '/api/state')).data;
    assert.equal(current.revision, initial.revision + 1);
    const patient = (await call(a, '/api/clinician/patients/live')).data;
    const values = { clinicalNote: 'INTEGRATION-PRIVATE', safetyNote: 'INTEGRATION-SAFETY', goal: 'Тестовая цель', plan: 'Тестовый план', watch: 'Наблюдение', earlyContact: 'Контакт', nextDate: '2026-11-01', nextTime: '14:00' };
    const confirmed = await call(b, '/api/clinician/patients/live/review', { type: 'confirm', revision: patient.review.revision, sourceRevision: patient.sourceRevision, episodeId: patient.episodeId, values, reviewed: true });
    assert.equal(confirmed.status, 200);
    await stop();
    const restarted = await start();
    const persisted = (await call(restarted, '/api/state')).data;
    assert.equal(persisted.revision, current.revision);
    assert.equal(persisted.carePlan.goal, values.goal);
    assert.doesNotMatch(JSON.stringify(persisted), /INTEGRATION-PRIVATE|INTEGRATION-SAFETY/);
    assert.equal((await call(restarted, '/api/clinician/patients/live')).data.review.confirmed.clinicalNote, values.clinicalNote);
    const shared = await call(restarted, '/api/action', { type: 'connect-doctor', consent: true, name: 'PostgreSQL integration fixture', revision: persisted.revision });
    assert.equal(shared.status, 200);
    const id = shared.data.careConnection.id;
    const signedIn = await call(restarted, '/api/clinic/session', { key: clinicKey });
    assert.equal(signedIn.status, 200);
    const authCookie = signedIn.cookie;
    authOwners.push('clinic-auth:' + createHash('sha256').update(authCookie.split('=')[1]).digest('hex'));
    const otherServer = await start();
    const protectedPatient = (await call(otherServer, '/api/clinic/patients/' + id, undefined, authCookie)).data;
    assert.equal(protectedPatient.identity.name, 'PostgreSQL integration fixture');
    assert.equal(protectedPatient.review.confirmed, null);
    const review = { type: 'confirm', revision: 0, sourceRevision: protectedPatient.sourceRevision, episodeId: protectedPatient.episodeId, values, reviewed: true };
    const writes = await Promise.all([restarted, otherServer].map(origin => call(origin, '/api/clinic/patients/' + id + '/review', review, authCookie)));
    assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);
    const linkedPlan = (await call(otherServer, '/api/state')).data;
    assert.equal(linkedPlan.carePlan.goal, values.goal);
    assert.doesNotMatch(JSON.stringify(linkedPlan), /INTEGRATION-PRIVATE|INTEGRATION-SAFETY/);
    const health = await call(otherServer, '/api/action', { type: 'health-context', revision: linkedPlan.revision, values: { medicines: 'INTEGRATION-SELF-REPORT', conditions: '', previousTreatment: '', functionExample: '', activation: 'unknown' } });
    assert.equal(health.status, 200);
    const source = (await call(otherServer, '/api/clinic/patients/' + id, undefined, authCookie)).data;
    assert.equal(source.medications[0].name, 'INTEGRATION-SELF-REPORT');
    const therapyValues = { ...emptyTherapyContext(), evidence: 'INTEGRATION-THERAPY-PRIVATE' };
    const therapy = await call(otherServer, '/api/clinic/patients/' + id + '/therapy-context', { episodeId: source.episodeId, sourceRevision: source.sourceRevision, contextRevision: 0, values: therapyValues }, authCookie);
    assert.equal(therapy.status, 200);
    assert.doesNotMatch(JSON.stringify((await call(otherServer, '/api/state')).data), /INTEGRATION-THERAPY-PRIVATE/);
    const aiWitness = { id: 'AI-PG-DRAFT-' + owner, sourceRevision: source.sourceRevision, episodeId: source.episodeId, model: 'openai/gpt-oss-20b', promptVersion: 'visit-priorities-v1', generatedAt: new Date().toISOString(), highlights: [], questions: [], usage: { input: 100, output: 10 } };
    await first.withSession(owner, async transaction => {
      const workspace = await transaction.getWorkspace(`clinic:${owner}`);
      workspace.aiSummaries = { [`${id}:${source.episodeId}`]: { draft: aiWitness, pending: null } };
      await transaction.saveWorkspace(`clinic:${owner}`, workspace);
    });
    assert.equal((await call(otherServer, '/api/clinic/patients/' + id, undefined, authCookie)).data.ai.draft.id, aiWitness.id);
    assert.doesNotMatch(JSON.stringify((await call(otherServer, '/api/state')).data), /AI-PG-DRAFT/);
    await stop();
    const afterDeployment = await start();
    const afterRestart = (await call(afterDeployment, '/api/clinic/patients/' + id, undefined, authCookie)).data;
    assert.equal(afterRestart.review.confirmed.id, linkedPlan.carePlan.id);
    assert.equal(afterRestart.ai.draft.id, aiWitness.id);
    assert.equal(afterRestart.therapy.context.evidence, 'INTEGRATION-THERAPY-PRIVATE');
    assert.equal(afterRestart.therapy.stale, false);
    assert.equal(afterRestart.medications[0].name, 'INTEGRATION-SELF-REPORT');
    assert.equal((await call(afterDeployment, '/api/clinic/logout', {}, authCookie)).status, 200);
    assert.equal((await call(afterDeployment, '/api/clinic/patients', undefined, authCookie)).status, 401);
    t.diagnostic('All persistence, revision and access assertions passed; cleaning up owned fixtures.');
  } finally {
    await stop(); await first.close(); await second.close();
    const url = new URL(databaseUrl);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']) url.searchParams.delete(key);
    const cleanup = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 12000, query_timeout: 12000 });
    try { await cleanup.query('DELETE FROM demo_telegram_chats WHERE session_id = $1', [row]); await cleanup.query('DELETE FROM demo_clinician_workspaces WHERE owner_id = ANY($1::text[])', [[owner, `clinic:${owner}`, ...authOwners]]); await cleanup.query('DELETE FROM demo_sessions WHERE id = ANY($1::text[])', [[owner, row]]); }
    finally { await cleanup.end(); }
  }
});
