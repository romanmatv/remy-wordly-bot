// Все виды дефисов и тире приводим к обычному дефису
const DASHES = /[\-\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE63\uFF0D]/g;

/**
 * Нормализация слова для сравнения:
 *  - регистр не учитывается;
 *  - «ё» приравнивается к «е»;
 *  - дефис (и любое тире) — часть слова: «Ростов-на-Дону», «вице-президент»;
 *  - всё остальное, кроме букв (знаки, цифры, смайлы, пробелы), отсекается;
 *  - повторяющиеся дефисы схлопываются, дефисы по краям убираются.
 */
export function normalizeWord(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(DASHES, '-')
    .replace(/[^a-zа-я-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Склеивает части слова, разделённые дефисом/тире с пробелами вокруг:
 * «Ростов - на - Дону» → «Ростов-на-Дону».
 */
function joinHyphenated(text) {
  return String(text ?? '').replace(/\s*[\-\u2010-\u2015\u2212\uFE63\uFF0D]+\s*/g, '-');
}

function tokens(text) {
  return joinHyphenated(text)
    .trim()
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
}

/** Нормализованная форма фразы: слова через один пробел («нижний новгород»). */
export function normalizePhrase(text) {
  return tokens(text).join(' ');
}

/** Количество слов (слова через дефис — одно слово). */
export function wordCount(text) {
  return tokens(text).length;
}

/**
 * Разбирает сообщение пользователя.
 * Возвращает нормализованную фразу или null, если в сообщении нет слов
 * или их больше, чем maxWords (в этом случае проверку не проводим).
 * Слова через дефис считаются одним словом.
 * Токены, которые после очистки пусты (смайлы, цифры, знаки), словами не считаются.
 */
export function extractWords(text, maxWords = 1) {
  const t = tokens(text);
  return t.length >= 1 && t.length <= maxWords ? t.join(' ') : null;
}

/** То же для одного слова */
export function extractSingleWord(text) {
  return extractWords(text, 1);
}

/** Слово «однословное» (его можно назвать одним сообщением). */
export function isSingleWord(text) {
  return tokens(text).length === 1;
}

/**
 * Красивый вид слова для вывода: обрезанные пробелы, единый дефис без пробелов вокруг.
 */
export function cleanDisplayWord(text) {
  return joinHyphenated(text)
    .replace(/\s+/g, ' ')
    .replace(/^-+|-+$/g, '')
    .trim();
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
