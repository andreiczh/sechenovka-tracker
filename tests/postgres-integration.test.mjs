import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresStore } from '../lib/postgres-store.mjs';
import { createAppServer } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';

// Explicit opt-in: regular CI must never read or change the deployment database.
test('PostgreSQL: verified TLS, rollback, concurrent servers and durable patient/doctor records', { skip: process.env.RUN_POSTGRES_TESTS !== '1' }, async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'DATABASE_URL is required for the opt-in integration check');
  const owner = randomUUID(), row = randomUUID();
  const first = createPostgresStore(databaseUrl);
  await first.ready;
  const second = createPostgresStore(databaseUrl);
  await second.ready;
  let servers = [];
  const start = async () => {
    const server = createAppServer({ config: readConfig({ DATABASE_URL: databaseUrl, REMINDER_SCHEDULER: 'off' }), logger: () => {} });
    await server.ready;
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { await Promise.all(servers.map(async server => { server.close(); await once(server, 'close'); })); servers = []; };
  const call = async (origin, path, body) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Cookie: `sechenovka_demo=${owner}`, ...(body ? { 'Content-Type': 'application/json', 'X-Demo-Client': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  try {
    await first.withSession(row, t => t.save(row, { count: 0 }));
    await assert.rejects(first.withSession(row, async t => { await t.save(row, { count: 999 }); throw new Error('fixture rollback'); }), /fixture rollback/);
    assert.equal(await second.withSession(row, async t => (await t.get(row)).count), 0);
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
  } finally {
    await stop(); await first.close(); await second.close();
    const url = new URL(databaseUrl);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']) url.searchParams.delete(key);
    const cleanup = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true } });
    try { await cleanup.query('DELETE FROM demo_clinician_workspaces WHERE owner_id = $1', [owner]); await cleanup.query('DELETE FROM demo_sessions WHERE id = ANY($1::text[])', [[owner, row]]); }
    finally { await cleanup.end(); }
  }
});
