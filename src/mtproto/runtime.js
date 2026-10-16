/**
 * Создание MTProto-клиента mtcute для Node.js без нативных модулей.
 *
 * Пакет @mtcute/node тянет за собой better-sqlite3 (нативный модуль, который не собирается
 * на части систем), поэтому здесь используется только платформенно-независимое ядро
 * @mtcute/core, а Node-часть (криптография, хранилище, транспорт MTProxy) реализована сама:
 *   - хранилище сессии — встроенный node:sqlite;
 *   - криптография — node:crypto + @mtcute/wasm (AES-IGE);
 *   - транспорт — TCP-соединение с MTProto proxy (обычные, dd- и ee/Fake TLS секреты).
 *
 * Модули mtcute подключаются динамически, только если прокси включён.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { createRequire } from 'node:module';
import {
  createCipheriv, createHash, createHmac, pbkdf2, randomFillSync,
} from 'node:crypto';
import { deflateSync, gunzipSync } from 'node:zlib';
import Database from '../sqlite.js';

const LEVEL_NAMES = ['', 'ERR', 'WRN', 'INF', 'DBG', 'VRB'];

/** Поиск .wasm-файла из пакета @mtcute/wasm */
function resolveWasm(file) {
  const req = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return req.resolve(`@mtcute/wasm/${file}`);
  } catch {
    const dir = path.join(process.cwd(), 'node_modules', '@mtcute', 'wasm');
    for (const p of [path.join(dir, file), path.join(dir, 'dist', file), path.join(dir, 'lib', file)]) {
      if (fs.existsSync(p)) return p;
    }
    throw new Error(`Не найден ${file} из пакета @mtcute/wasm — выполните npm install`);
  }
}

export async function createMtprotoClient({ apiId, apiHash, proxy, sessionPath }) {
  const core = await import('@mtcute/core');
  const coreUtils = await import('@mtcute/core/utils.js');
  const { BaseTelegramClient, TelegramClient } = await import('@mtcute/core/client.js');
  const wasm = await import('@mtcute/wasm');
  const { connectTcp } = await import('@fuman/node');

  // ---- платформа: логи, хук завершения, имя устройства
  const exitCallbacks = new Set();
  process.once('exit', () => {
    for (const cb of exitCallbacks) {
      try { cb(); } catch { /* ignore */ }
    }
  });
  const platform = {
    beforeExit(fn) {
      exitCallbacks.add(fn);
      return () => exitCallbacks.delete(fn);
    },
    log(color, level, tag, fmt, args) {
      let text;
      try {
        text = util.format(fmt, ...args);
      } catch {
        text = `${fmt} ${args.join(' ')}`;
      }
      console.log(`[mtproto ${LEVEL_NAMES[level] ?? level}] [${tag}] ${text}`);
    },
    getDefaultLogLevel() {
      const lvl = Number.parseInt(process.env.MTCUTE_LOG_LEVEL ?? '');
      return Number.isNaN(lvl) ? 2 : lvl; // по умолчанию — только ошибки и предупреждения
    },
    getDeviceModel() {
      return `Node.js/${process.version} (${os.type()} ${os.arch()})`;
    },
  };

  // ---- криптография (аналог NodeCryptoProvider из @mtcute/node)
  class NodeCryptoProvider extends coreUtils.BaseCryptoProvider {
    createAesCtr(key, iv) {
      const cipher = createCipheriv(`aes-${key.length * 8}-ctr`, key, iv);
      return { process: (data) => cipher.update(data) };
    }
    pbkdf2(password, salt, iterations, keylen = 64, algo = 'sha512') {
      return new Promise((resolve, reject) =>
        pbkdf2(password, salt, iterations, keylen, algo, (err, buf) => (err ? reject(err) : resolve(buf))),
      );
    }
    sha1(data) { return createHash('sha1').update(data).digest(); }
    sha256(data) { return createHash('sha256').update(data).digest(); }
    hmacSha256(data, key) { return createHmac('sha256', key).update(data).digest(); }
    gzip(data, maxSize) {
      try {
        return deflateSync(data, { maxOutputLength: maxSize });
      } catch (e) {
        if (e.code === 'ERR_BUFFER_TOO_LARGE') return null;
        throw e;
      }
    }
    gunzip(data) { return gunzipSync(data); }
    randomFill(buf) { randomFillSync(buf); }
    async initialize() {
      const file = wasm.SIMD_AVAILABLE ? 'mtcute-simd.wasm' : 'mtcute.wasm';
      wasm.initSync(fs.readFileSync(resolveWasm(file)));
    }
    createAesIge(key, iv) {
      return {
        encrypt: (data) => wasm.ige256Encrypt(data, key, iv),
        decrypt: (data) => wasm.ige256Decrypt(data, key, iv),
      };
    }
  }

  // ---- хранилище сессии на node:sqlite (аналог SqliteStorage из @mtcute/node)
  class NodeSqliteDriver extends core.BaseSqliteStorageDriver {
    constructor(filename) {
      super();
      this.filename = filename;
    }
    _createDatabase() {
      const db = new Database(this.filename);
      db.pragma('journal_mode = WAL');
      return db;
    }
  }
  class NodeSqliteStorage extends core.BaseSqliteStorage {
    constructor(filename) {
      super(new NodeSqliteDriver(filename));
    }
  }

  // ---- транспорт: TCP до MTProto proxy (аналог MtProxyTcpTransport из @mtcute/node)
  class MtProxyTcpTransport extends core.BaseMtProxyTransport {
    async _connectTcp(endpoint, abortSignal) {
      const conn = await connectTcp(endpoint, abortSignal);
      conn.setNoDelay(true);
      conn.setKeepAlive(true);
      return conn;
    }
  }

  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });

  const base = new BaseTelegramClient({
    apiId,
    apiHash,
    storage: new NodeSqliteStorage(sessionPath),
    crypto: new NodeCryptoProvider(),
    transport: new MtProxyTcpTransport(proxy),
    platform,
  });

  const tg = new TelegramClient({ client: base });
  return { tg, core };
}
