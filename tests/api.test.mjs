import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
test('local API saves across server restart, isolates sessions, rejects stale updates and cross-site writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sechenovka-api-'));
  let server;
  const start = async () => { server = createAppServer({ config: readConfig({}), storePath: join(dir, 'test.sqlite') }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
  const stop = async () => { server.close(); await once(server, 'close'); };
  try {
    let url = await start();
    const initial = await fetch(`${url}/api/state`), cookie = initial.headers.get('set-cookie').split(';')[0], state = await initial.json();
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    const post = body => fetch(`${url}/api/action`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Demo-Client': '1' }, body: JSON.stringify(body) });
    const joined = await post({ type: 'join', adult: true, revision: state.revision }); assert.equal(joined.status, 200);
    const started = await post({ type: 'start', revision: (await joined.json()).revision }); assert.equal(started.status, 200);
    const active = await started.json();
    const answered = await post({ type: 'answer', questionId: 'phq-0', value: 2, revision: active.revision }); assert.equal(answered.status, 200);
    const duplicate = await post({ type: 'answer', questionId: 'phq-0', value: 1, revision: active.revision }); assert.equal(duplicate.status, 409);
    const isolated = await (await fetch(`${url}/api/state`)).json(); assert.equal(isolated.joined, false);
    const cross = await fetch(`${url}/api/action`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json', 'X-Demo-Client': '1', Cookie: cookie }, body: '{}' }); assert.equal(cross.status, 403);
    const simple = await fetch(`${url}/api/action`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' }); assert.equal(simple.status, 403);
    await stop(); url = await start();
    const restored = await (await fetch(`${url}/api/state`, { headers: { Cookie: cookie } })).json();
    assert.equal(restored.active.values['phq-0'], 2); assert.equal(restored.flow.question.id, 'phq-1');
    for (const path of ['/', '/patient/', '/bot/', '/shared/clinical.js', '/patient/manifest.webmanifest']) assert.equal((await fetch(url + path)).status, 200);
    assert.equal((await fetch(`${url}/.data/demo.sqlite`)).status, 404);
  } finally { if (server?.listening) await stop(); await rm(dir, { recursive: true, force: true }); }
});
