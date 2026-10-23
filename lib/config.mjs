import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

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
  const telegramToken = env.TELEGRAM_BOT_TOKEN || '';
  const telegramWebhookSecret = env.TELEGRAM_WEBHOOK_SECRET || '';
  const telegramIdentitySecret = env.TELEGRAM_IDENTITY_SECRET || '';
  const telegramUsername = env.TELEGRAM_BOT_USERNAME || 'sechenov_track_bot';
  if (telegramToken && (!/^\d+:[A-Za-z0-9_-]{25,}$/.test(telegramToken) || !/^[A-Za-z0-9_-]{32,256}$/.test(telegramWebhookSecret) || telegramIdentitySecret.length < 32 || !publicOrigin?.startsWith('https:'))) throw new Error('Для Telegram нужны HTTPS, токен и два отдельных серверных секрета');
  // A purpose-separated key enables the teaching clinic on existing Telegram
  // installations. It cannot reveal or replace the Telegram identity secret.
  const clinicianAccessKey = env.CLINICIAN_ACCESS_KEY || (telegramToken ? createHmac('sha256', telegramIdentitySecret).update('sechenovka-clinician-access-v1').digest('base64url') : '');
  if (clinicianAccessKey && (clinicianAccessKey.length < 24 || clinicianAccessKey.length > 256)) throw new Error('CLINICIAN_ACCESS_KEY должен содержать 24–256 символов');
  return { production, publicOrigin, host: env.HOST || env.IP || (env.RENDER ? '0.0.0.0' : '127.0.0.1'), port, storePath: resolve(dataDirectory, 'demo.sqlite'), databaseUrl, storage: databaseUrl ? 'postgres' : 'sqlite', scheduler, cronSecret, telegramToken, telegramWebhookSecret, telegramIdentitySecret, telegramUsername, clinicianAccessKey };
}

export function acceptsHost(config, host) {
  if (typeof host !== 'string') return false;
  return config.publicOrigin ? host.toLowerCase() === new URL(config.publicOrigin).host.toLowerCase() : /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}
export function acceptsOrigin(config, host, origin) {
  return !origin || origin === (config.publicOrigin || `http://${host}`);
}
