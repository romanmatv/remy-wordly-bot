/**
 * Игры-цепочки «Существительные» и «Города»:
 * следующее слово начинается на последнюю букву предыдущего.
 * Если свободных слов на эту букву нет — берём предыдущую букву (следующую с конца) и т.д.
 */
import { CATEGORIES } from '../config.js';
import { escapeHtml } from '../normalize.js';
import { formatStats } from '../stats.js';

export const CHAIN_TYPES = ['nouns', 'cities'];

const up = (l) => l.toUpperCase();

/** Определяет букву, на которую должно начинаться следующее слово. */
export function nextLetter(store, chatId, category, norm) {
  for (let i = norm.length - 1; i >= 0; i--) {
    const letter = norm[i];
    if (!/[a-zа-я]/.test(letter)) continue; // дефис и пробел — не буквы
    if (store.hasFreeWordOnLetter(chatId, category, letter)) return letter;
  }
  return null;
}

function letterHint(norm, letter) {
  const last = norm.replace(/[^a-zа-я]/g, '').slice(-1);
  return letter === last
    ? `Следующее слово на букву «<b>${up(letter)}</b>»`
    : `На «${up(last)}» слов нет — следующее слово на букву «<b>${up(letter)}</b>»`;
}

/** Старт игры: бот называет случайное слово из категории. */
export function startChain(store, chatId, category, userId) {
  store.startGame(chatId, category, {}, userId);

  for (let attempt = 0; attempt < 50; attempt++) {
    const w = store.randomWord(chatId, [category]);
    if (!w) break;
    store.markUsed(chatId, w.norm);
    const letter = nextLetter(store, chatId, category, w.norm);
    if (!letter) continue;
    store.saveState(chatId, { letter, lastWord: w.word });
    return {
      ok: true,
      text:
        `🎮 Игра «<b>${CATEGORIES[category]}</b>» началась!\n` +
        `Называйте слово на последнюю букву предыдущего. За каждое верное слово — 1 балл.\n\n` +
        `Я начинаю: <b>${escapeHtml(w.word)}</b>\n${letterHint(w.norm, letter)}`,
    };
  }

  store.stopGame(chatId);
  return { ok: false, text: `В категории «${CATEGORIES[category]}» нет слов — добавьте их через /addword.` };
}

/** Обработка ответа игрока. Возвращает true, если сообщение относилось к игре. */
export async function handleChainAnswer(ctx, store, game, norm, playerName) {
  const chatId = ctx.chat.id;
  const category = game.type;
  const { letter } = game.state;

  // Слово не на нужную букву — это просто разговор в чате, не реагируем
  if (!letter || norm[0] !== letter) return false;

  const row = store.findWord(category, norm);
  if (!row) {
    await ctx.reply(`🤔 Не знаю такого слова в категории «${CATEGORIES[category]}».`, {
      reply_parameters: { message_id: ctx.msg.message_id },
    });
    return true;
  }

  if (store.isUsed(chatId, norm)) {
    await ctx.reply(`🔁 Слово «${escapeHtml(row.word)}» уже было в этой игре.`, {
      parse_mode: 'HTML',
      reply_parameters: { message_id: ctx.msg.message_id },
    });
    return true;
  }

  store.markUsed(chatId, norm);
  store.addPoint(chatId, ctx.from.id, category, 1);
  const next = nextLetter(store, chatId, category, norm);

  if (!next) {
    store.stopGame(chatId);
    await ctx.reply(
      `✅ <b>${playerName}</b>, верно! +1\n\n🏁 Слова для продолжения закончились — игра окончена.\n\n` +
        formatStats(store, chatId),
      { parse_mode: 'HTML' },
    );
    return true;
  }

  store.saveState(chatId, { letter: next, lastWord: row.word });
  await ctx.reply(
    `✅ <b>${playerName}</b>, верно! +1\n<b>${escapeHtml(row.word)}</b> → ${letterHint(norm, next)}`,
    { parse_mode: 'HTML', reply_parameters: { message_id: ctx.msg.message_id } },
  );
  return true;
}

export function chainStatus(game) {
  return `Сейчас идёт игра «${CATEGORIES[game.type]}». Последнее слово: <b>${escapeHtml(
    game.state.lastWord ?? '—',
  )}</b>, нужна буква «<b>${up(game.state.letter ?? '?')}</b>».`;
}
