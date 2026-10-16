import './suppress-warnings.js';
import 'dotenv/config';
import { Bot, InlineKeyboard, GrammyError, HttpError } from 'grammy';
import { config, CATEGORIES, GAME_TYPES, MAX_WORDS } from './config.js';
import { openDb, seed } from './db.js';
import { readMtprotoConfig } from './mtproto/config.js';
import { createMtprotoBridge } from './mtproto/bridge.js';
import { createStore } from './store.js';
import { extractWords, escapeHtml } from './normalize.js';
import { formatStats, formatStatsElsewhere } from './stats.js';
import { CHAIN_TYPES, startChain, handleChainAnswer, chainStatus } from './games/chain.js';
import {
  startCroc, onLead, onShow, onChange, handleCrocAnswer,
  checkCrocTimeouts, crocStatus, crocStopNote, onWordDeleted, onAllWordsDeleted,
} from './games/crocodile.js';

if (!config.token) {
  console.error('Не задан BOT_TOKEN. Создайте файл .env (см. .env.example).');
  process.exit(1);
}

const db = openDb(config);
const store = createStore(db);
const bot = new Bot(config.token);

const PENDING_TTL_MS = 10 * 60 * 1000;
const HTML = { parse_mode: 'HTML' };

const nameOf = (user) =>
  escapeHtml([user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `id${user.id}`);

// Запоминаем имена всех, кто пишет, — для статистики
bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    store.rememberUser(ctx.from);
    if (ctx.chat) store.rememberMember(ctx.chat.id, ctx.from.id);
  }
  await next();
});

// ---------------------------------------------------------------- команды

const HELP =
  '🎲 <b>Игры в слова</b>\n\n' +
  '🔤 <b>Существительные</b> и 🏙 <b>Города</b> — называйте слово на последнюю букву предыдущего ' +
  '(если на неё слов нет — на предпоследнюю и т.д.). Слова в игре не повторяются.\n' +
  '🐊 <b>Крокодил</b> — ведущий объясняет слово, остальные угадывают.\n\n' +
  'За каждый правильный ответ — 1 балл.\n\n' +
  '/startgame — начать игру\n' +
  '/stopgame — остановить текущую игру\n' +
  '/stat — счёт в этом чате и суммарно в других чатах\n' +
  '/clearstat — очистить счёт в этом чате\n' +
  '/addword — добавить слово в словарь\n' +
  '/delword — удалить слово из словаря';

bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, HTML));

bot.command('stat', (ctx) =>
  ctx.reply(
    formatStats(store, ctx.chat.id, '📊 <b>Счёт в этом чате</b>') + '\n\n' + formatStatsElsewhere(store, ctx.chat.id),
    HTML,
  ),
);

bot.command('clearstat', async (ctx) => {
  store.clearScores(ctx.chat.id);
  await ctx.reply('🧹 Счёт игроков в этом чате очищен.');
});

bot.command('startgame', async (ctx) => {
  const game = store.getGame(ctx.chat.id);
  if (game) {
    return ctx.reply(`${statusOf(game)}\n\nЧтобы начать другую, сначала остановите эту: /stopgame`, HTML);
  }
  const kb = new InlineKeyboard()
    .text('🔤 Существительные', 'start:nouns').row()
    .text('🏙 Города', 'start:cities').row()
    .text('🐊 Крокодил', 'start:croc');
  await ctx.reply('Во что играем?', { reply_markup: kb });
});

bot.command('stopgame', async (ctx) => {
  const chatId = ctx.chat.id;
  const game = store.getGame(chatId);
  if (!game) return ctx.reply('Сейчас нет активной игры. Начать: /startgame');
  const note = game.type === 'croc' ? crocStopNote(game) : '';
  store.stopGame(chatId);
  await ctx.reply(
    `⏹ Игра «${GAME_TYPES[game.type]}» остановлена.\n${note}\n` +
      formatStats(store, chatId, '📊 <b>Итоговый счёт</b>'),
    HTML,
  );
});

bot.command('addword', async (ctx) => {
  const uid = ctx.from.id;
  const kb = new InlineKeyboard()
    .text('🔤 Существительные', `add:nouns:${uid}`)
    .text('🏙 Города', `add:cities:${uid}`).row()
    .text('📦 Прочее', `add:other:${uid}`)
    .text('✖️ Отмена', `add:cancel:${uid}`);
  await ctx.reply(`${nameOf(ctx.from)}, выберите категорию для нового слова:`, { ...HTML, reply_markup: kb });
});

bot.command('delword', async (ctx) => {
  const arg = ctx.match?.trim();
  if (arg) return deleteWord(ctx, arg);
  store.setPending(ctx.chat.id, ctx.from.id, 'del');
  await ctx.reply(`${nameOf(ctx.from)}, пришлите слово, которое нужно удалить из словаря.`, {
    ...HTML,
    reply_markup: { force_reply: true, selective: true },
    reply_parameters: { message_id: ctx.msg.message_id },
  });
});

// ---------------------------------------------------------------- скрытые команды
// Не показываются в /help и в меню команд Telegram.

const isAdmin = (user) => !config.adminIds.length || config.adminIds.includes(user?.id);

bot.command('seedbase', async (ctx) => {
  if (!isAdmin(ctx.from)) return; // для посторонних команды «не существует»
  await ctx.reply('⏳ Загружаю слова из CSV-файлов…');
  const before = store.countWords();
  const result = seed(db, config.csv);
  const lines = result.map((r) =>
    r.missing
      ? `• ${CATEGORIES[r.category]}: файл <code>${escapeHtml(r.file)}</code> не найден`
      : `• ${CATEGORIES[r.category]} (<code>${escapeHtml(r.file)}</code>): добавлено <b>${r.added}</b>, ` +
        `пропущено дубликатов — ${r.duplicates}`,
  );
  await ctx.reply(
    `✅ Загрузка словарей завершена.\n\n${lines.join('\n')}\n\nСлов в базе: ${before} → <b>${store.countWords()}</b>`,
    HTML,
  );
});

bot.command('delwordsall', async (ctx) => {
  if (!isAdmin(ctx.from)) return;
  const n = store.countWords();
  if (!n) return ctx.reply('Словарь и так пуст. Загрузить слова: /seedbase');
  const uid = ctx.from.id;
  const kb = new InlineKeyboard()
    .text('🗑 Да, удалить все слова', `wipe:yes:${uid}`)
    .row()
    .text('✖️ Отмена', `wipe:no:${uid}`);
  await ctx.reply(
    `⚠️ <b>Удалить все слова из словаря?</b>\n\nБудет удалено слов: <b>${n}</b> (во всех категориях и для всех чатов). ` +
      'Действие необратимо. Счёт игроков не пострадает.\n\n<i>Подтверждение действует 2 минуты.</i>',
    { ...HTML, reply_markup: kb },
  );
});

bot.callbackQuery(/^wipe:(yes|no):(\d+)$/, async (ctx) => {
  const [, answer, ownerId] = ctx.match;
  if (String(ctx.from.id) !== ownerId) {
    return ctx.answerCallbackQuery({ text: 'Подтвердить может только тот, кто вызвал команду.', show_alert: true });
  }
  await ctx.answerCallbackQuery();
  const done = (text) => ctx.editMessageText(text, HTML).catch(() => ctx.reply(text, HTML));

  if (answer === 'no') return done('Удаление слов отменено.');

  const sentAt = (ctx.callbackQuery.message?.date ?? 0) * 1000;
  if (Date.now() - sentAt > config.wipeConfirmMs) {
    return done('⌛ Время подтверждения истекло. Запустите /delwordsall ещё раз.');
  }
  if (!isAdmin(ctx.from)) return done('Недостаточно прав.');

  const removed = store.deleteAllWords();
  console.log(`[db] пользователь ${ctx.from.id} удалил все слова (${removed})`);
  await done(`🗑 Удалено слов: <b>${removed}</b>. Словарь пуст.\nЗагрузить слова из CSV: /seedbase`);
  await onAllWordsDeleted(ctx.api, store);
});

// ---------------------------------------------------------------- кнопки

bot.callbackQuery(/^start:(nouns|cities|croc)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const type = ctx.match[1];
  const existing = store.getGame(chatId);
  if (existing) {
    return ctx.answerCallbackQuery({
      text: `Уже идёт игра «${GAME_TYPES[existing.type]}». Сначала /stopgame`,
      show_alert: true,
    });
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  if (type === 'croc') {
    const r = startCroc(store, chatId, ctx.from.id);
    return ctx.reply(r.text, { ...HTML, reply_markup: r.keyboard });
  }
  const r = startChain(store, chatId, type, ctx.from.id);
  return ctx.reply(r.text, HTML);
});

bot.callbackQuery(/^add:(nouns|cities|other|cancel):(\d+)$/, async (ctx) => {
  const [, category, ownerId] = ctx.match;
  if (String(ctx.from.id) !== ownerId) {
    return ctx.answerCallbackQuery({ text: 'Эта кнопка для того, кто вызвал /addword.', show_alert: true });
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  if (category === 'cancel') {
    store.clearPending(ctx.chat.id, ctx.from.id);
    return ctx.editMessageText('Добавление слова отменено.').catch(() => ctx.reply('Добавление слова отменено.'));
  }
  store.setPending(ctx.chat.id, ctx.from.id, 'add', category);
  await ctx.reply(
    `${nameOf(ctx.from)}, пришлите слово для категории «${CATEGORIES[category]}» (${
      MAX_WORDS[category] > 1 ? `до ${MAX_WORDS[category]} слов` : 'одно слово'
    }).`,
    { ...HTML, reply_markup: { force_reply: true, selective: true } },
  );
});

bot.callbackQuery('croc:lead', (ctx) => onLead(ctx, store, nameOf));
bot.callbackQuery('croc:show', (ctx) => onShow(ctx, store));
bot.callbackQuery('croc:change', (ctx) => onChange(ctx, store));
bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery()); // устаревшие кнопки

// ---------------------------------------------------------------- сообщения

bot.on('message:text', async (ctx) => {
  if (ctx.from.is_bot) return;
  const text = ctx.msg.text;
  if (text.startsWith('/')) return; // неизвестные команды игнорируем

  const chatId = ctx.chat.id;

  // 1. Ожидаем от пользователя слово для /addword или /delword
  const pending = store.getPending(chatId, ctx.from.id);
  if (pending) {
    store.clearPending(chatId, ctx.from.id);
    if (Date.now() - pending.created_at <= PENDING_TTL_MS) {
      if (pending.action === 'add') return addWord(ctx, pending.category, text);
      if (pending.action === 'del') return deleteWord(ctx, text);
    }
  }

  // 2. Ответ в текущей игре
  const game = store.getGame(chatId);
  if (!game) return;
  // В «Городах» допускается ответ из двух слов, в остальных играх — только одно слово
  const norm = extractWords(text, MAX_WORDS[game.type] ?? 1);
  if (!norm) return;

  const player = nameOf(ctx.from);
  if (CHAIN_TYPES.includes(game.type)) await handleChainAnswer(ctx, store, game, norm, player);
  else if (game.type === 'croc') await handleCrocAnswer(ctx, store, game, norm, player);
});

// ---------------------------------------------------------------- словарь

async function addWord(ctx, category, text) {
  const word = text.trim();
  const max = MAX_WORDS[category] ?? 1;
  if (!extractWords(word, max)) {
    const hint = max > 1 ? `не больше ${max} слов` : 'ровно одно слово';
    return ctx.reply(`❌ Нужно прислать ${hint}. Попробуйте ещё раз: /addword`);
  }
  const res = store.addWord(category, word, ctx.from.id);
  if (res.ok) {
    return ctx.reply(`✅ Слово «<b>${escapeHtml(res.row.word)}</b>» добавлено в «${CATEGORIES[category]}».`, HTML);
  }
  return ctx.reply(`ℹ️ Слово «<b>${escapeHtml(word)}</b>» уже есть в «${CATEGORIES[category]}».`, HTML);
}

async function deleteWord(ctx, text) {
  const norm = extractWords(text, Math.max(...Object.values(MAX_WORDS)));
  if (!norm) return ctx.reply('❌ Нужно указать слово: /delword слово');
  const removed = store.deleteWord(norm);
  if (!removed.length) {
    return ctx.reply(`Слова «<b>${escapeHtml(text.trim())}</b>» нет в словаре.`, HTML);
  }
  const cats = [...new Set(removed.map((r) => CATEGORIES[r.category]))].join(', ');
  await ctx.reply(`🗑 Слово «<b>${escapeHtml(removed[0].word)}</b>» удалено (${cats}).`, HTML);
  // Если это слово сейчас загадано в Крокодиле (в любом чате) — сбрасываем ведущего
  await onWordDeleted(ctx.api, store, norm);
}

function statusOf(game) {
  return game.type === 'croc' ? crocStatus(game) : chainStatus(game);
}

// ---------------------------------------------------------------- запуск

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error('Ошибка Telegram API:', e.description);
  else if (e instanceof HttpError) console.error('Сетевая ошибка:', e);
  else console.error('Ошибка при обработке апдейта:', e);
});

let timer = null;
let mtprotoBridge = null;

async function shutdown() {
  clearInterval(timer);
  await bot.stop().catch(() => {});
  await mtprotoBridge?.stop();
  db.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function main() {
  // Подключение через MTProto proxy (если задан в .env)
  const mtproto = readMtprotoConfig(process.env, config.dbPath);
  if (mtproto) {
    mtprotoBridge = await createMtprotoBridge({ token: config.token, mtproto });
    // все вызовы Bot API из grammY пойдут через MTProto
    bot.api.config.use(mtprotoBridge.transformer);
  }

  await bot.api
    .setMyCommands([
      { command: 'startgame', description: 'Начать игру' },
      { command: 'stopgame', description: 'Остановить текущую игру' },
      { command: 'stat', description: 'Счёт: этот чат и другие чаты' },
      { command: 'clearstat', description: 'Очистить счёт в этом чате' },
      { command: 'addword', description: 'Добавить слово в словарь' },
      { command: 'delword', description: 'Удалить слово из словаря' },
      { command: 'help', description: 'Правила и команды' },
    ])
    .catch((e) => console.warn('Не удалось установить список команд:', e.message));

  timer = setInterval(() => {
    checkCrocTimeouts(bot.api, store).catch((e) => console.error('[croc timer]', e));
  }, config.timerIntervalMs);
  // Проверим таймауты сразу после старта (бот мог быть выключен)
  checkCrocTimeouts(bot.api, store).catch(() => {});

  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) =>
      console.log(`Бот @${me.username} запущен${mtproto ? ' (через MTProto proxy)' : ''}`),
  });
}

main().catch((e) => {
  console.error('Не удалось запустить бота:', e?.message ?? e);
  process.exit(1);
});
