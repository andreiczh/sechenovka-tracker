import { readConfig } from '../lib/config.mjs';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Используйте Node.js 24 LTS или новее');
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('SELECT 1'); db.close();
for (const file of ['public/index.html', 'public/patient/index.html', 'public/psychiatrist/index.html', 'public/psychiatrist/psychiatrist.js', 'public/bot/index.html', 'public/shared/clinical.js', 'server.mjs']) await access(resolve(root, file), constants.R_OK);
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const config = readConfig();
console.log(JSON.stringify({ ok: true, version, node: process.versions.node, mode: config.production ? 'hosted-synthetic-demo' : 'local-synthetic-demo', publicOrigin: config.publicOrigin, storage: config.storage, scheduler: config.scheduler, psychiatristImplemented: true, telegramConfigured: Boolean(config.telegramToken) }));
