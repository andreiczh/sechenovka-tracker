import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

if (!process.env.DATA_DIR) throw new Error('Задайте DATA_DIR с действующей базой');
const targetDirectory = resolve(process.env.DATA_DIR, 'backups');
await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
const target = resolve(targetDirectory, `demo-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`);
const db = new DatabaseSync(resolve(process.env.DATA_DIR, 'demo.sqlite'), { readOnly: true });
try { await backup(db, target); } finally { db.close(); }
console.log(target);
