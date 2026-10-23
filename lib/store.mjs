import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS demo_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS demo_clinician_workspaces (owner_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  const read = db.prepare('SELECT state FROM demo_sessions WHERE id = ?');
  const write = db.prepare('INSERT INTO demo_sessions (id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state');
  const readWorkspace = db.prepare('SELECT state FROM demo_clinician_workspaces WHERE owner_id = ?');
  const writeWorkspace = db.prepare('INSERT INTO demo_clinician_workspaces (owner_id, state) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET state=excluded.state');
  const queues = new Map();
  const store = { get: id => { const row = read.get(id); return row ? JSON.parse(row.state) : null; }, save: (id, state) => write.run(id, JSON.stringify(state)),
    getWorkspace: id => { const row = readWorkspace.get(id); return row ? JSON.parse(row.state) : null; }, saveWorkspace: (id, state) => writeWorkspace.run(id, JSON.stringify(state)),
    all: () => db.prepare('SELECT id, state FROM demo_sessions').all().map(r => ({ id: r.id, state: JSON.parse(r.state) })), close: () => db.close(), ready: Promise.resolve() };
  store.withSession = async (id, callback) => {
    const previous = queues.get(id) || Promise.resolve();
    let unlock;
    const pending = new Promise(resolve => { unlock = resolve; });
    queues.set(id, pending);
    await previous;
    try { return await callback(store); }
    finally { unlock(); if (queues.get(id) === pending) queues.delete(id); }
  };
  return store;
}
