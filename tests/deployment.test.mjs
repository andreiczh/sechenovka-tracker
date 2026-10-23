import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readConfig } from '../lib/config.mjs';
import { createAppServer } from '../server.mjs';

const SECRET = 'fixture-only-do-not-use-in-production-12345';
const environment = dataDirectory => ({ NODE_ENV: 'production', DEMO_MODE: 'true', PUBLIC_ORIGIN: 'https://fixture.alwaysdata.net', DATA_DIR: dataDirectory, IP: '::', PORT: '8301', REMINDER_SCHEDULER: 'external', CRON_SECRET: SECRET });

test('hosting configuration requires HTTPS, synthetic mode, external data and safe scheduler', () => {
  const valid = environment(join(tmpdir(), 'sechenovka-fixture-data'));
  assert.equal(readConfig(valid).host, '::');
  assert.equal(readConfig({ ...valid, HOST: '127.0.0.2' }).host, '127.0.0.2');
  assert.equal(readConfig(valid).port, 8301);
  for (const override of [{ PUBLIC_ORIGIN: '' }, { PUBLIC_ORIGIN: 'http://fixture.alwaysdata.net' }, { PUBLIC_ORIGIN: 'https://fixture.alwaysdata.net/path' }, { PUBLIC_ORIGIN: 'https://user:pass@fixture.alwaysdata.net' }, { DATA_DIR: '' }, { DATA_DIR: '.data' }, { DATA_DIR: process.cwd() }, { DEMO_MODE: 'false' }, { REMINDER_SCHEDULER: 'local' }, { CRON_SECRET: '' }, { PORT: 'no' }]) assert.throws(() => readConfig({ ...valid, ...override }));
  assert.equal(readConfig({}).scheduler, 'local');
});

test('public proxy host/origin, secure cookie, stateless health, protected cron, WAL backup and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sechenovka-deploy-'));
  const config = readConfig(environment(dir));
  const errors = [];
  let wall = Date.parse('2026-10-23T05:30:00Z'), server, port;
  const start = async () => { server = createAppServer({ config, wallClock: () => wall, logger: event => errors.push(event) }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port; };
  const stop = async () => { server.close(); await once(server, 'close'); };
  const call = (path, method = 'GET', body, extra = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: 'fixture.alwaysdata.net', ...extra } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, data, text }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    await start();
    const health = await call('/healthz');
    assert.equal(health.status, 200); assert.equal(health.data.ok, true); assert.equal(health.headers['set-cookie'], undefined);
    const db = new DatabaseSync(config.storePath);
    assert.equal(db.prepare('SELECT count(*) AS n FROM demo_sessions').get().n, 0); db.close();
    assert.equal((await call('/patient/')).status, 200);
    assert.equal((await call('/healthz', 'GET', undefined, { Host: 'evil.example' })).status, 403);
    assert.equal((await call('/api/state', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('/api/state', 'GET', undefined, { Origin: 'http://fixture.alwaysdata.net', 'X-Forwarded-Proto': 'https' })).status, 403);
    assert.equal((await call('/internal/reminders/run', 'POST')).status, 403);
    const initial = await call('/api/state');
    assert.match(initial.headers['set-cookie'][0], /HttpOnly; SameSite=Strict.*; Secure/);
    const cookie = initial.headers['set-cookie'][0].split(';')[0];
    let state = initial.data;
    const post = async action => {
      const result = await call('/api/action', 'POST', { ...action, revision: state.revision }, { Cookie: cookie, Origin: config.publicOrigin, 'Content-Type': 'application/json', 'X-Demo-Client': '1' });
      assert.equal(result.status, 200, result.text); state = result.data;
    };
    await post({ type: 'join', adult: true });
    await post({ type: 'start' });
    await post({ type: 'answer', questionId: 'phq-0', value: 2 });
    await post({ type: 'reminders', settings: { enabled: true, times: ['09:00'], timeZone: 'Europe/Moscow' } });
    wall = Date.parse('2026-10-23T06:00:30Z');
    assert.equal((await call('/internal/reminders/run', 'POST', undefined, { Authorization: `Bearer ${SECRET}` })).data.changedProfiles, 1);
    assert.equal((await call('/internal/reminders/run', 'POST', undefined, { Authorization: `Bearer ${SECRET}` })).data.changedProfiles, 0);
    const response = await call('/api/state', 'GET', undefined, { Cookie: cookie });
    assert.equal(response.data.deliveries.length, 1);
    // Backup while the writer is open: the committed WAL record must survive.
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/backup.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: dir } });
    const backupDb = new DatabaseSync(stdout.trim(), { readOnly: true });
    const backedUp = JSON.parse(backupDb.prepare('SELECT state FROM demo_sessions').get().state);
    assert.equal(backedUp.active.values['phq-0'], 2); assert.equal(backedUp.deliveries.length, 1); backupDb.close();
    await stop(); await start();
    const restored = (await call('/api/state', 'GET', undefined, { Cookie: cookie })).data;
    assert.equal(restored.active.values['phq-0'], 2); assert.equal(restored.deliveries.length, 1);
    const serializedErrors = JSON.stringify(errors);
    assert.doesNotMatch(serializedErrors, /fixture-only|sechenovka_demo|phq-0/);
    assert.equal(errors.every(e => e.event === 'http_error' && Number.isInteger(e.status)), true);
  } finally { if (server?.listening) await stop(); await rm(dir, { recursive: true, force: true }); }
});
