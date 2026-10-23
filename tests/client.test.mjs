import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJSON } from '../public/shared/client.js';

test('F08: HTML errors and connection failures produce understandable Russian messages', async t => {
  for (const mock of [async () => new Response('<html>Bad gateway</html>', { status: 502 }), async () => { throw new TypeError('Failed to fetch'); }]) {
    t.mock.method(globalThis, 'fetch', mock);
    await assert.rejects(requestJSON('/api/action', { method: 'POST' }), error => {
      assert.match(error.message, /сервер|соединение/);
      assert.doesNotMatch(error.message, /Unexpected|Failed to fetch|<html>/);
      assert.equal(error.uncertain, true);
      return true;
    });
    t.mock.restoreAll();
  }
});

test('F08: an unresponsive write is aborted, never automatically retried', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  await assert.rejects(requestJSON('/api/action', { method: 'POST' }, 20), error => {
    assert.match(error.message, /долго не отвечает/);
    assert.equal(error.uncertain, true);
    return true;
  });
  assert.equal(calls, 1);
});

test('F08: revision conflicts retain the server state, and a successful retry returns confirmed data', async t => {
  const state = { revision: 2, flow: { question: { id: 'phq-1' } } };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Данные изменились в другом окне', state }, { status: 409 }));
  await assert.rejects(requestJSON('/api/action', { method: 'POST' }), error => {
    assert.deepEqual(error.state, state);
    return true;
  });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json(state));
  assert.deepEqual(await requestJSON('/api/state'), state);
});
