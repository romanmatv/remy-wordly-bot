import fs from 'node:fs';
import path from 'node:path';
import Database from './sqlite.js';
import { normalizePhrase, wordCount, cleanDisplayWord } from './normalize.js';
import { MAX_WORDS } from './config.js';
import { parseCities, parseFirstColumnTsv } from './csv.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS words (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT    NOT NULL CHECK (category IN ('nouns', 'cities', 'other')),
  word         TEXT    NOT NULL,             -- как показывать
  norm         TEXT    NOT NULL,             -- нормализованная форма для сравнения
  first_letter TEXT    NOT NULL,
  single       INTEGER NOT NULL DEFAULT 1,   -- 1 = слово можно назвать в игре (не длиннее MAX_WORDS)
  added_by     INTEGER,                      -- NULL = из CSV
  created_at   INTEGER NOT NULL,
  UNIQUE (category, norm)
);
CREATE INDEX IF NOT EXISTS idx_words_cat_letter ON words (category, first_letter);
CREATE INDEX IF NOT EXISTS idx_words_norm ON words (norm);

-- Текущая игра в каждом чате (одна активная игра на чат)
CREATE TABLE IF NOT EXISTS games (
  chat_id    INTEGER PRIMARY KEY,
  type       TEXT    NOT NULL CHECK (type IN ('nouns', 'cities', 'croc')),
  state      TEXT    NOT NULL DEFAULT '{}',  -- JSON с контекстом игры
  started_by INTEGER,
  started_at INTEGER NOT NULL
);

-- Слова, уже прозвучавшие в текущей игре чата
CREATE TABLE IF NOT EXISTS used_words (
  chat_id INTEGER NOT NULL,
  norm    TEXT    NOT NULL,
  PRIMARY KEY (chat_id, norm)
);

-- Счёт игроков по чатам и видам игр
CREATE TABLE IF NOT EXISTS scores (
  chat_id   INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  game_type TEXT    NOT NULL CHECK (game_type IN ('nouns', 'cities', 'croc')),
  points    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id, game_type)
);

-- Имена пользователей для вывода статистики
CREATE TABLE IF NOT EXISTS users (
  user_id    INTEGER PRIMARY KEY,
  name       TEXT,
  username   TEXT,
  updated_at INTEGER
);

-- Участники чатов (кто писал в чат) — чтобы в /stat показать их счёт в других чатах
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

-- Ожидаемые от пользователя действия (/addword, /delword)
CREATE TABLE IF NOT EXISTS pending (
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  action     TEXT    NOT NULL CHECK (action IN ('add', 'del')),
  category   TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
`;

export function insertWordsStmt(db) {
  return db.prepare(`
    INSERT OR IGNORE INTO words (category, word, norm, first_letter, single, added_by, created_at)
    VALUES (@category, @word, @norm, @first_letter, @single, @added_by, @created_at)
  `);
}

/** Можно ли назвать слово в игре: количество слов не больше допустимого для категории */
export function isPlayable(category, word) {
  return wordCount(word) <= (MAX_WORDS[category] ?? 1);
}

export function wordRow(category, word, addedBy = null) {
  const norm = normalizePhrase(word);
  if (!norm) return null;
  return {
    category,
    word: cleanDisplayWord(word),
    norm,
    first_letter: norm[0],
    single: isPlayable(category, word) ? 1 : 0,
    added_by: addedBy,
    created_at: Date.now(),
  };
}

/**
 * Добавляет слова категории, пропуская те, что уже есть в базе
 * (сравнение по нормализованной форме: регистр, ё/е, знаки не важны).
 * Дубликаты внутри самого файла тоже пропускаются.
 */
function seedCategory(db, category, words) {
  const insert = insertWordsStmt(db);
  //const exists = db.prepare('SELECT 1 FROM words WHERE category = ? AND norm = ? LIMIT 1');
  const stats = { added: 0, duplicates: 0, invalid: 0 };
  db.transaction(() => {
    for (const w of words) {
      const row = wordRow(category, w);
      if (!row) {
        stats.invalid++;
        continue;
      }
      /*if (exists.get(category, row.norm)) {
        stats.duplicates++;
        continue;
      }*/
      insert.run(row);
      stats.added++;
    }
  })();
  return stats;
}

/**
 * Загрузка словарей из CSV. Используется при создании БД и командой /seedbase.
 * Возвращает статистику по категориям.
 */
export function seed(db, csv) {
  const sources = [
    ['cities', csv.cities, parseCities],
    ['nouns', csv.nouns, parseFirstColumnTsv],
    ['other', csv.other, parseFirstColumnTsv],
  ];
  const result = [];
  for (const [category, file, parser] of sources) {
    const name = path.basename(file);
    if (!fs.existsSync(file)) {
      console.warn(`[db] CSV не найден: ${file} — категория «${category}» пропущена`);
      result.push({ category, file: name, missing: true });
      continue;
    }
    const stats = seedCategory(db, category, parser(file));
    console.log(
      `[db] ${category}: из ${name} добавлено ${stats.added}, дубликатов пропущено ${stats.duplicates}`,
    );
    result.push({ category, file: name, ...stats });
  }
  return result;
}

const SCHEMA_VERSION = 3;

/** Обновление существующей БД до текущей версии */
function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= SCHEMA_VERSION) return;

  db.transaction(() => {
    // v2: дефис — часть слова; v3: в городах допустимы два слова (норма хранится с пробелом).
    // Пересчитываем нормализованные формы и признак «можно назвать в игре».
    const rows = db.prepare('SELECT id, category, word, norm, single FROM words').all();
    const upd = db.prepare(
      'UPDATE OR IGNORE words SET word = ?, norm = ?, first_letter = ?, single = ? WHERE id = ?',
    );
    let changed = 0;
    for (const r of rows) {
      const word = cleanDisplayWord(r.word);
      const norm = normalizePhrase(word);
      const single = isPlayable(r.category, word) ? 1 : 0;
      if (!norm || (norm === r.norm && word === r.word && single === r.single)) continue;
      if (upd.run(word, norm, norm[0], single, r.id).changes) changed++;
    }

    if (version < 2) {
      // старые формы без дефисов → новые, для уже прозвучавших слов текущих игр
      const used = db.prepare('SELECT chat_id, norm FROM used_words').all();
      db.exec('DELETE FROM used_words');
      const ins = db.prepare('INSERT OR IGNORE INTO used_words (chat_id, norm) VALUES (?, ?)');
      const find = db.prepare("SELECT norm FROM words WHERE replace(norm, '-', '') = ? LIMIT 1");
      for (const u of used) {
        const w = find.get(u.norm);
        ins.run(u.chat_id, w ? w.norm : u.norm);
      }
      // загаданные слова в Крокодиле
      const updGame = db.prepare('UPDATE games SET state = ? WHERE chat_id = ?');
      for (const g of db.prepare("SELECT chat_id, state FROM games WHERE type = 'croc'").all()) {
        const st = JSON.parse(g.state);
        if (st.word) {
          st.norm = normalizePhrase(st.word);
          updGame.run(JSON.stringify(st), g.chat_id);
        }
      }
    }
    console.log(`[db] обновление словаря до версии ${SCHEMA_VERSION}: изменено ${changed} слов`);
  })();
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function openDb(config) {
  const isNew = !fs.existsSync(config.dbPath);
  if (isNew) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    console.log(`[db] Файл БД не найден, создаю: ${config.dbPath}`);
  }
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  if (isNew) {
    seed(db, config.csv);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else {
    migrate(db);
  }
  return db;
}
