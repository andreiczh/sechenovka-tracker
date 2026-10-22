import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS demo_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  const read = db.prepare('SELECT state FROM demo_sessions WHERE id = ?');
  const write = db.prepare('INSERT INTO demo_sessions (id, state) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state');
  return { get: id => { const row = read.get(id); return row ? JSON.parse(row.state) : null; }, save: (id, state) => write.run(id, JSON.stringify(state)), all: () => db.prepare('SELECT id, state FROM demo_sessions').all().map(r => ({ id: r.id, state: JSON.parse(r.state) })), close: () => db.close() };
}
