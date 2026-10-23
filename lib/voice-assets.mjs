import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function createVoiceAssets({ cacheDirectory = resolve(app, '.data/voice-assets'), fetchImpl = fetch } = {}) {
  let manifest; const pending = new Map();
  return async path => {
    manifest ||= JSON.parse(await readFile(resolve(app, 'docs/evidence/voice-assets.json'), 'utf8'));
    const entry = Object.hasOwn(manifest.assets, path) ? manifest.assets[path] : null;
    if (!entry) return null;
    if (!pending.has(path)) pending.set(path, (async () => {
      const target = resolve(cacheDirectory, path), valid = b => b.length === entry.size && createHash('sha256').update(b).digest('hex') === entry.sha256;
      try { const b = await readFile(target); if (valid(b)) return target; } catch { /* Fetch only this pinned, public model asset. */ }
      const response = await fetchImpl(entry.url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error('Речевой модуль пока не загрузился. Повторите загрузку.');
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > entry.size) { await response.body.cancel().catch(() => {}); throw new Error('Размер речевого модуля не совпал.'); } chunks.push(chunk); }
      const buffer = Buffer.concat(chunks);
      if (!valid(buffer)) throw new Error('Не удалось проверить речевой модуль.');
      await mkdir(dirname(target), { recursive: true }); const temp = target + '.' + randomUUID();
      try { await writeFile(temp, buffer); await rename(temp, target); } finally { await unlink(temp).catch(() => {}); }
      return target;
    })().catch(error => { pending.delete(path); throw error; }));
    return { file: await pending.get(path), size: entry.size, version: manifest.version, sha: entry.sha256 };
  };
}
