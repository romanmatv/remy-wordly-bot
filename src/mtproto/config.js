/**
 * Настройки подключения через MTProto proxy (MTProxy).
 *
 * Прокси можно задать:
 *   MTPROXY=tg://proxy?server=1.2.3.4&port=443&secret=ee...        (или https://t.me/proxy?...)
 * либо по отдельности:
 *   MTPROXY_HOST=1.2.3.4
 *   MTPROXY_PORT=443
 *   MTPROXY_SECRET=ee...   (hex или base64; поддерживаются обычные, dd- и ee-секреты / Fake TLS)
 *
 * Для MTProto нужны api_id и api_hash приложения: https://my.telegram.org → API development tools
 *   TELEGRAM_API_ID=123456
 *   TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
 */
import path from 'node:path';

function parseProxyLink(link) {
  let url;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error(`MTPROXY: не удалось разобрать ссылку «${link}»`);
  }
  const isTg = url.protocol === 'tg:' && url.hostname === 'proxy';
  const isTme = /^https?:$/.test(url.protocol) && /(^|\.)t\.me$|(^|\.)telegram\.me$/.test(url.hostname) && url.pathname.replace(/\/+$/, '') === '/proxy';
  if (!isTg && !isTme) {
    throw new Error('MTPROXY: ожидается ссылка вида tg://proxy?server=...&port=...&secret=... или https://t.me/proxy?...');
  }
  return {
    host: url.searchParams.get('server') ?? '',
    port: url.searchParams.get('port') ?? '',
    secret: url.searchParams.get('secret') ?? '',
  };
}

/**
 * Возвращает настройки MTProto или null, если прокси не задан (тогда бот работает через обычный Bot API).
 * Бросает ошибку с понятным текстом, если настройки заданы не полностью.
 */
export function readMtprotoConfig(env, dbPath) {
  const link = env.MTPROXY?.trim();
  const parts = link
    ? parseProxyLink(link)
    : { host: env.MTPROXY_HOST?.trim(), port: env.MTPROXY_PORT?.trim(), secret: env.MTPROXY_SECRET?.trim() };

  if (!parts.host && !parts.port && !parts.secret) return null;

  const missing = [];
  if (!parts.host) missing.push('адрес (server / MTPROXY_HOST)');
  if (!parts.port) missing.push('порт (port / MTPROXY_PORT)');
  if (!parts.secret) missing.push('секрет (secret / MTPROXY_SECRET)');
  const port = Number(parts.port);
  if (parts.port && !(Number.isInteger(port) && port > 0 && port < 65536)) missing.push('корректный порт');

  const apiId = Number(env.TELEGRAM_API_ID);
  const apiHash = env.TELEGRAM_API_HASH?.trim();
  if (!Number.isInteger(apiId) || apiId <= 0) missing.push('TELEGRAM_API_ID');
  if (!apiHash) missing.push('TELEGRAM_API_HASH');

  if (missing.length) {
    throw new Error(`Для подключения через MTProto proxy не хватает настроек: ${missing.join(', ')}`);
  }

  return {
    proxy: { host: parts.host, port, secret: parts.secret },
    apiId,
    apiHash,
    // файл сессии MTProto (ключи авторизации и кэш чатов) — рядом с базой бота
    sessionPath: path.resolve(env.MTPROTO_SESSION || path.join(path.dirname(dbPath), 'mtproto.session')),
  };
}

/** Строка для логов без секрета */
export function describeProxy(cfg) {
  const s = String(cfg.proxy.secret);
  return `${cfg.proxy.host}:${cfg.proxy.port} (secret ${s.slice(0, 4)}…)`;
}
