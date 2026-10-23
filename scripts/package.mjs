import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const target = resolve(root, 'dist', `sechenovka-v${version}.tar.gz`);
await mkdir(resolve(root, 'dist'), { recursive: true });
// An allowlist keeps databases, .env, credentials, Git and test screenshots out.
const files = ['package.json', 'package-lock.json', 'render.yaml', 'server.mjs', 'lib', 'public', 'scripts', 'tests', 'README.md', '.env.example', 'docs', '.github'];
const result = spawnSync('tar', ['--exclude=.DS_Store', '--exclude=__voice-test.*', '--exclude=__layout-test.*', '-czf', target, '-C', root, ...files], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('Не удалось собрать архив размещения');
console.log(target);
