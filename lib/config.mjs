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
  const groqApiKey = env.GROQ_API_KEY || '';
  if (groqApiKey && (groqApiKey.length < 16 || groqApiKey.length > 512 || /\s/.test(groqApiKey))) throw new Error('Проверьте серверный GROQ_API_KEY');
  const groqModel = env.GROQ_MODEL || 'openai/gpt-oss-20b';
  if (!['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(groqModel)) throw new Error('GROQ_MODEL: openai/gpt-oss-20b или openai/gpt-oss-120b');
  const aiProvider = env.AI_PROVIDER || (env.OPENROUTER_API_KEY ? 'openrouter' : 'groq');
  if (!['groq', 'openrouter'].includes(aiProvider)) throw new Error('AI_PROVIDER: groq или openrouter');
  const aiApiKey = aiProvider === 'groq' ? groqApiKey : env.OPENROUTER_API_KEY || '';
  if (aiApiKey && (aiApiKey.length < 16 || aiApiKey.length > 512 || /\s/.test(aiApiKey))) throw new Error('Проверьте серверный ключ ИИ-провайдера');
  const aiModel = aiProvider === 'groq' ? groqModel : env.OPENROUTER_MODEL || 'dots-studio/dots-3-note-preview:free';
  if (aiProvider !== 'groq' && aiModel !== 'dots-studio/dots-3-note-preview:free') throw new Error('Для бесплатного шлюза разрешена только проверенная dots-studio/dots-3-note-preview:free');
  const aiEnabled = Boolean(aiApiKey);
  const aiDailyLimit = Number(env.AI_DAILY_LIMIT || 20);
  if (!Number.isInteger(aiDailyLimit) || aiDailyLimit < 1 || aiDailyLimit > 100) throw new Error('AI_DAILY_LIMIT должен быть от 1 до 100');
  return { production, publicOrigin, host: env.HOST || env.IP || (env.RENDER ? '0.0.0.0' : '127.0.0.1'), port, storePath: resolve(dataDirectory, 'demo.sqlite'), databaseUrl, storage: databaseUrl ? 'postgres' : 'sqlite', scheduler, cronSecret, telegramToken, telegramWebhookSecret, telegramIdentitySecret, telegramUsername, clinicianAccessKey, groqApiKey, groqModel, aiDailyLimit, aiProvider, aiApiKey, aiModel, aiEnabled };
}

export function acceptsHost(config, host) {
  if (typeof host !== 'string') return false;
  return config.publicOrigin ? host.toLowerCase() === new URL(config.publicOrigin).host.toLowerCase() : /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}
export function acceptsOrigin(config, host, origin) {
  return !origin || origin === (config.publicOrigin || `http://${host}`);
}
