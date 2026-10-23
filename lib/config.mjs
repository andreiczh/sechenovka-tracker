import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL || null;
  if (databaseUrl) {
    let database;
    try { database = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL должен содержать адрес PostgreSQL'); }
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.username || !database.password || !database.pathname.slice(1)) throw new Error('Проверьте серверные настройки PostgreSQL');
    if (database.searchParams.get('sslmode') === 'disable') throw new Error('Для PostgreSQL требуется проверяемое TLS-соединение');
  }
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535');
  let publicOrigin = null;
  const configuredOrigin = env.PUBLIC_ORIGIN || (env.RENDER ? env.RENDER_EXTERNAL_URL : null);
  if (configuredOrigin) {
    let url;
    try { url = new URL(configuredOrigin); } catch { throw new Error('PUBLIC_ORIGIN должен содержать полный адрес сайта'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_ORIGIN должен содержать только протокол и домен');
    if (production && url.protocol !== 'https:') throw new Error('Для публикации требуется HTTPS в PUBLIC_ORIGIN');
    publicOrigin = url.origin;
  }
  if (production && !publicOrigin) throw new Error('Перед публикацией задайте PUBLIC_ORIGIN');
  if ((production && env.DEMO_MODE !== 'true') || env.DEMO_MODE === 'false') throw new Error('Этот прототип запускается только с DEMO_MODE=true и вымышленными данными');
  if (production && !databaseUrl && (!env.DATA_DIR || !isAbsolute(env.DATA_DIR))) throw new Error('DATA_DIR должен быть абсолютным путём к постоянной папке вне каталога кода');
  const dataDirectory = resolve(env.DATA_DIR || resolve(projectDirectory, '.data'));
  if (production && !databaseUrl && (dataDirectory === projectDirectory || dataDirectory.startsWith(projectDirectory + '/'))) throw new Error('Для публикации DATA_DIR нужно вынести за пределы каталога кода');
  const scheduler = env.REMINDER_SCHEDULER || (production ? 'external' : 'local');
  if (!['local', 'external', 'off'].includes(scheduler)) throw new Error('REMINDER_SCHEDULER: local, external или off');
  if (production && scheduler === 'local') throw new Error('Для публикации используйте REMINDER_SCHEDULER=external или off');
  const cronSecret = env.CRON_SECRET || '';
  if (scheduler === 'external' && cronSecret.length < 32) throw new Error('Для планировщика задайте CRON_SECRET длиной не менее 32 символов');
  return { production, publicOrigin, host: env.HOST || env.IP || (env.RENDER ? '0.0.0.0' : '127.0.0.1'), port, storePath: resolve(dataDirectory, 'demo.sqlite'), databaseUrl, storage: databaseUrl ? 'postgres' : 'sqlite', scheduler, cronSecret };
}

export function acceptsHost(config, host) {
  if (typeof host !== 'string') return false;
  return config.publicOrigin ? host.toLowerCase() === new URL(config.publicOrigin).host.toLowerCase() : /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}
export function acceptsOrigin(config, host, origin) {
  return !origin || origin === (config.publicOrigin || `http://${host}`);
}
