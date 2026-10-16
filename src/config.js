import path from 'node:path';

const root = process.cwd();
const p = (v, def) => path.resolve(root, v || def);

export const config = {
  token: process.env.BOT_TOKEN,
  // id пользователей, которым доступны скрытые команды /seedbase и /delwordsall.
  // Пусто — доступны всем.
  adminIds: (process.env.ADMIN_IDS || '')
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number),
  // Сколько действует кнопка подтверждения /delwordsall
  wipeConfirmMs: 2 * 60 * 1000,
  dbPath: p(process.env.DB_PATH, 'data/wordly.db'),
  csv: {
    cities: p(process.env.CITY_CSV, 'city.csv'),
    nouns: p(process.env.NOUNS_CSV, 'nouns.csv'),
    other: p(process.env.OTHER_CSV, 'verbs.csv'),
  },
  // Крокодил: сколько ждём правильного ответа, прежде чем раскрыть слово
  crocTimeoutMs: 2 * 24 * 60 * 60 * 1000,
  // Крокодил: сколько секунд ведущим может стать только угадавший
  crocExclusiveMs: 15 * 1000,
  // Как часто проверять таймауты Крокодила
  timerIntervalMs: 60 * 1000,
};

export const CATEGORIES = {
  nouns: 'Существительные',
  cities: 'Города',
  other: 'Прочее',
};

/** Сколько слов может быть в ответе для каждой категории (слова через дефис — одно слово) */
export const MAX_WORDS = {
  nouns: 1,
  cities: 2, // «Нижний Новгород», «Белые Столбы»
  other: 1,
};

export const GAME_TYPES = {
  nouns: 'Существительные',
  cities: 'Города',
  croc: 'Крокодил',
};
