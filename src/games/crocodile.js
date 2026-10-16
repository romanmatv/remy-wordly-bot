/**
 * Крокодил: ведущий видит слово во всплывающем окне и объясняет его,
 * остальные угадывают. Слова — из категорий «Существительные» и «Прочее».
 *
 * Состояние (games.state):
 *   phase          'waiting' — ждём ведущего, 'playing' — идёт раунд
 *   leaderId       id ведущего
 *   word, norm     загаданное слово
 *   roundStartedAt когда начался раунд (для таймаута 2 суток)
 *   winnerId       кто угадал последним (приоритет на роль ведущего)
 *   exclusiveUntil до какого момента ведущим может стать только winnerId
 */
import { InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { escapeHtml } from '../normalize.js';
import { formatStats } from '../stats.js';

export const CROC_CATEGORIES = ['nouns', 'other'];

const leadKeyboard = () => new InlineKeyboard().text('🎤 Стать ведущим', 'croc:lead');
const leaderKeyboard = () =>
  new InlineKeyboard().text('👀 Показать слово', 'croc:show').text('🔄 Сменить слово', 'croc:change');

export function startCroc(store, chatId, userId) {
  store.startGame(chatId, 'croc', { phase: 'waiting', winnerId: null, exclusiveUntil: 0 }, userId);
  return {
    text:
      '🐊 <b>Крокодил</b> начался!\n' +
      'Ведущий получает слово во всплывающем окне и объясняет его, не называя. ' +
      'Кто первым напишет слово — получает 1 балл.\n\nКто будет ведущим?',
    keyboard: leadKeyboard(),
  };
}

function pickWord(store, chatId) {
  const w = store.randomWord(chatId, CROC_CATEGORIES);
  if (w) store.markUsed(chatId, w.norm);
  return w;
}

async function finishNoWords(ctx, store, chatId) {
  store.stopGame(chatId);
  await ctx.reply('🏁 Слова для Крокодила закончились — игра окончена.\n\n' + formatStats(store, chatId), {
    parse_mode: 'HTML',
  });
}

/** Кнопка «Стать ведущим» */
export async function onLead(ctx, store, nameOf) {
  const chatId = ctx.chat.id;
  const game = store.getGame(chatId);
  if (!game || game.type !== 'croc') {
    return ctx.answerCallbackQuery({ text: 'Крокодил сейчас не идёт. /startgame', show_alert: true });
  }
  const s = game.state;
  if (s.phase === 'playing') {
    return ctx.answerCallbackQuery({ text: 'Ведущий уже выбран.', show_alert: true });
  }
  const now = Date.now();
  if (s.winnerId && now < s.exclusiveUntil && ctx.from.id !== s.winnerId) {
    const left = Math.ceil((s.exclusiveUntil - now) / 1000);
    return ctx.answerCallbackQuery({
      text: `Первые 15 секунд ведущим может стать только тот, кто угадал слово. Подождите ещё ${left} с.`,
      show_alert: true,
    });
  }

  const w = pickWord(store, chatId);
  if (!w) {
    await ctx.answerCallbackQuery();
    return finishNoWords(ctx, store, chatId);
  }

  store.saveState(chatId, {
    phase: 'playing',
    leaderId: ctx.from.id,
    word: w.word,
    norm: w.norm,
    roundStartedAt: now,
    winnerId: null,
    exclusiveUntil: 0,
  });

  await ctx.answerCallbackQuery({ text: `Ваше слово: ${w.word}`, show_alert: true });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    `🎤 Ведущий — <b>${nameOf(ctx.from)}</b>. Объясняйте слово, остальные угадывают!\n` +
      `<i>Слово видит только ведущий по кнопке ниже.</i>`,
    { parse_mode: 'HTML', reply_markup: leaderKeyboard() },
  );
}

/**
 * Сброс ведущего: раунд прерывается без начисления очков,
 * ведущим может стать любой участник.
 */
export async function resetCrocLeader(api, store, chatId, reason) {
  store.saveState(chatId, { phase: 'waiting', winnerId: null, exclusiveUntil: 0 });
  try {
    await api.sendMessage(chatId, `${reason}\n\nВедущий сброшен — кто будет новым ведущим?`, {
      parse_mode: 'HTML',
      reply_markup: leadKeyboard(),
    });
  } catch (e) {
    console.error(`[croc] не удалось отправить сообщение в чат ${chatId}:`, e.message);
  }
}

/** Загаданное слово ещё есть в словаре? */
function wordExists(store, norm) {
  return store.findWordAnyCategory(norm).some((w) => CROC_CATEGORIES.includes(w.category));
}

/**
 * Вызывается после удаления слова из словаря: во всех чатах, где это слово
 * сейчас загадано в Крокодиле, сбрасываем ведущего.
 * Возвращает список chat_id, где был сброс.
 */
export async function onWordDeleted(api, store, norm) {
  const affected = [];
  for (const game of store.gamesOfType('croc')) {
    const s = game.state;
    if (s.phase !== 'playing' || s.norm !== norm || wordExists(store, norm)) continue;
    affected.push(game.chat_id);
    await resetCrocLeader(api, store, game.chat_id, '⚠️ Загаданное слово удалили из словаря, раунд прерван.');
  }
  return affected;
}

/** После очистки словаря: прерываем все идущие раунды Крокодила */
export async function onAllWordsDeleted(api, store) {
  for (const game of store.gamesOfType('croc')) {
    if (game.state.phase !== 'playing') continue;
    await resetCrocLeader(api, store, game.chat_id, '⚠️ Словарь очищен, раунд прерван.');
  }
}

/** Кнопка «Показать слово» — только ведущему */
export async function onShow(ctx, store) {
  const game = store.getGame(ctx.chat.id);
  const s = game?.type === 'croc' ? game.state : null;
  if (!s || s.phase !== 'playing') {
    return ctx.answerCallbackQuery({ text: 'Сейчас нет загаданного слова.', show_alert: true });
  }
  if (ctx.from.id !== s.leaderId) {
    return ctx.answerCallbackQuery({ text: 'Слово видит только ведущий 🙂', show_alert: true });
  }
  if (!wordExists(store, s.norm)) {
    await ctx.answerCallbackQuery({ text: 'Загаданное слово удалено из словаря.', show_alert: true });
    return resetCrocLeader(ctx.api, store, ctx.chat.id, '⚠️ Загаданное слово удалили из словаря, раунд прерван.');
  }
  return ctx.answerCallbackQuery({ text: `Ваше слово: ${s.word}`, show_alert: true });
}

/** Кнопка «Сменить слово» — ведущий может нажать в любой момент */
export async function onChange(ctx, store) {
  const chatId = ctx.chat.id;
  const game = store.getGame(chatId);
  const s = game?.type === 'croc' ? game.state : null;
  if (!s || s.phase !== 'playing') {
    return ctx.answerCallbackQuery({ text: 'Сейчас нет загаданного слова.', show_alert: true });
  }
  if (ctx.from.id !== s.leaderId) {
    return ctx.answerCallbackQuery({ text: 'Сменить слово может только ведущий.', show_alert: true });
  }
  const w = pickWord(store, chatId);
  if (!w) {
    return ctx.answerCallbackQuery({ text: 'Других слов не осталось.', show_alert: true });
  }
  store.saveState(chatId, { ...s, word: w.word, norm: w.norm });
  await ctx.answerCallbackQuery({ text: `Новое слово: ${w.word}`, show_alert: true });
}

/** Проверка сообщения в чате. Возвращает true, если слово угадано. */
export async function handleCrocAnswer(ctx, store, game, norm, playerName) {
  const s = game.state;
  if (s.phase !== 'playing') return false;
  if (ctx.from.id === s.leaderId) return false; // ведущий не может угадывать
  if (norm !== s.norm) return false;

  const chatId = ctx.chat.id;
  const now = Date.now();
  store.addPoint(chatId, ctx.from.id, 'croc', 1);
  store.saveState(chatId, {
    phase: 'waiting',
    winnerId: ctx.from.id,
    exclusiveUntil: now + config.crocExclusiveMs,
    lastWord: s.word,
  });
  await ctx.reply(
    `🎉 <b>${playerName}</b> угадал(а) слово «<b>${escapeHtml(s.word)}</b>»! +1\n\n` +
      `${playerName}, станете ведущим? Первые 15 секунд это право только у вас, потом — у любого.`,
    {
      parse_mode: 'HTML',
      reply_parameters: { message_id: ctx.msg.message_id },
      reply_markup: leadKeyboard(),
    },
  );
  return true;
}

/** Периодическая проверка: слово не угадано 2 суток — раскрываем его. */
export async function checkCrocTimeouts(api, store) {
  const now = Date.now();
  for (const game of store.gamesOfType('croc')) {
    const s = game.state;
    if (s.phase !== 'playing' || now - s.roundStartedAt < config.crocTimeoutMs) continue;
    store.saveState(game.chat_id, { phase: 'waiting', winnerId: null, exclusiveUntil: 0, lastWord: s.word });
    try {
      await api.sendMessage(
        game.chat_id,
        `⏰ За двое суток слово никто не угадал. Было загадано: «<b>${escapeHtml(s.word)}</b>».\n\n` +
          'Ведущим может стать любой игрок:',
        { parse_mode: 'HTML', reply_markup: leadKeyboard() },
      );
    } catch (e) {
      console.error(`[croc] не удалось отправить сообщение в чат ${game.chat_id}:`, e.message);
    }
  }
}

export function crocStatus(game) {
  const s = game.state;
  return s.phase === 'playing'
    ? 'Сейчас идёт Крокодил — ведущий объясняет слово.'
    : 'Сейчас идёт Крокодил — ждём нового ведущего.';
}

export function crocStopNote(game) {
  return game.state.phase === 'playing' && game.state.word
    ? `Загаданное слово было: «<b>${escapeHtml(game.state.word)}</b>».\n\n`
    : '';
}
