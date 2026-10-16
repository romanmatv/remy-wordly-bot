/**
 * Мост «Bot API ↔ MTProto» для grammY.
 *
 * Bot API (api.telegram.org) работает только по HTTPS и не умеет ходить через MTProto proxy.
 * Поэтому при включённом прокси бот подключается к Telegram напрямую по протоколу MTProto
 * (библиотека mtcute), а этот модуль подменяет вызовы Bot API в grammY через «трансформер»:
 * grammY по-прежнему думает, что вызывает getUpdates/sendMessage/..., но запросы
 * выполняются через MTProto. Вся логика бота (команды, кнопки, игры) остаётся без изменений.
 *
 * Поддерживаются методы, которые использует бот:
 *   getMe, getUpdates, deleteWebhook, close, logOut, setMyCommands,
 *   sendMessage, editMessageText, editMessageReplyMarkup, answerCallbackQuery.
 */
import { createMtprotoClient } from './runtime.js';
import { describeProxy } from './config.js';

const MAX_QUEUE = 1000;
const MAX_CALLBACKS = 500;

// ---------------------------------------------------------------- MTProto → Bot API

function userToApi(u) {
  if (!u) return undefined;
  return {
    id: u.id,
    is_bot: Boolean(u.isBot),
    first_name: u.firstName || u.displayName || String(u.id),
    ...(u.lastName ? { last_name: u.lastName } : {}),
    ...(u.username ? { username: u.username } : {}),
  };
}

const CHAT_TYPES = {
  group: 'group',
  channel: 'channel',
  supergroup: 'supergroup',
  gigagroup: 'supergroup',
  monoforum: 'supergroup',
  community: 'supergroup',
};

function chatToApi(peer) {
  if (!peer) return undefined;
  if (peer.type === 'user') {
    return {
      id: peer.id,
      type: 'private',
      first_name: peer.firstName || String(peer.id),
      ...(peer.lastName ? { last_name: peer.lastName } : {}),
      ...(peer.username ? { username: peer.username } : {}),
    };
  }
  return {
    id: peer.id,
    type: CHAT_TYPES[peer.chatType] ?? 'supergroup',
    title: peer.title,
    ...(peer.username ? { username: peer.username } : {}),
  };
}

function entitiesToApi(entities) {
  const out = [];
  for (const e of entities ?? []) {
    if (!e?.kind) continue;
    out.push({ type: e.kind, offset: e.offset, length: e.length });
  }
  return out;
}

function messageToApi(m) {
  const sender = m.sender;
  const msg = {
    message_id: m.id,
    date: Math.floor(m.date.getTime() / 1000),
    chat: chatToApi(m.chat),
  };
  if (sender?.type === 'user') msg.from = userToApi(sender);
  else if (sender) msg.sender_chat = chatToApi(sender);
  if (m.text) {
    msg.text = m.text;
    const entities = entitiesToApi(m.entities);
    if (entities.length) msg.entities = entities;
  }
  return msg;
}

// ---------------------------------------------------------------- Bot API → MTProto

function toInputText(text, parseMode, thtml) {
  const s = String(text ?? '');
  return parseMode && String(parseMode).toUpperCase() === 'HTML' ? thtml(s) : s;
}

function toReplyMarkup(markup, BotKeyboard) {
  if (!markup) return undefined;
  if (markup.inline_keyboard) {
    const rows = markup.inline_keyboard
      .map((row) =>
        row
          .map((b) => {
            if (b.callback_data != null) return BotKeyboard.callback(b.text, String(b.callback_data));
            if (b.url) return BotKeyboard.url(b.text, b.url);
            return null;
          })
          .filter(Boolean),
      )
      .filter((row) => row.length);
    return rows.length ? BotKeyboard.inline(rows) : undefined;
  }
  if (markup.force_reply) {
    return BotKeyboard.forceReply({
      ...(markup.selective ? { selective: true } : {}),
      ...(markup.input_field_placeholder ? { placeholder: markup.input_field_placeholder } : {}),
    });
  }
  if (markup.remove_keyboard) {
    return BotKeyboard.hideReply(Boolean(markup.selective));
  }
  return undefined;
}

function replyToId(payload) {
  return payload.reply_parameters?.message_id ?? payload.reply_to_message_id ?? undefined;
}

// ---------------------------------------------------------------- мост

export async function createMtprotoBridge({ token, mtproto }) {
  console.log(`[mtproto] подключение к Telegram через MTProto proxy ${describeProxy(mtproto)}…`);
  const { tg, core } = await createMtprotoClient(mtproto);
  const { thtml } = await import('@mtcute/html-parser');
  const { BotKeyboard, Long } = core;

  // --- очередь апдейтов для getUpdates
  const queue = [];
  let nextUpdateId = 1;
  let waiters = [];
  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };
  const push = (update) => {
    update.update_id = nextUpdateId++;
    queue.push(update);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    wake();
  };

  // callback-запросы храним, чтобы ответить на них по строковому id
  const callbacks = new Map();

  tg.onError?.add?.((err) => console.error('[mtproto] ошибка:', err?.message ?? err));

  tg.onUpdate.add((upd) => {
    try {
      if (upd.name === 'new_message') {
        const m = upd.data;
        if (m.isOutgoing || m.isService) return;
        push({ message: messageToApi(m) });
      } else if (upd.name === 'callback_query') {
        const q = upd.data;
        const id = q.id.toString();
        callbacks.set(id, q);
        if (callbacks.size > MAX_CALLBACKS) callbacks.delete(callbacks.keys().next().value);
        // Bot API передаёт дату сообщения с кнопкой — получим её (нужна для истечения подтверждений)
        (async () => {
          let date = Math.floor(Date.now() / 1000);
          try {
            const [msg] = await tg.getMessages(q.chat, q.messageId);
            if (msg) date = Math.floor(msg.date.getTime() / 1000);
          } catch { /* оставим текущее время */ }
          push({
            callback_query: {
              id,
              from: userToApi(q.user),
              chat_instance: q.uniqueChatId.toString(),
              ...(q.dataStr != null ? { data: q.dataStr } : {}),
              message: { message_id: q.messageId, date, chat: chatToApi(q.chat) },
            },
          });
        })();
      }
    } catch (e) {
      console.error('[mtproto] не удалось обработать апдейт:', e);
    }
  });

  const self = await tg.start({ botToken: token });
  const me = {
    ...userToApi(self),
    is_bot: true,
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  console.log(`[mtproto] авторизован как @${self.username} через MTProto proxy`);

  // --- ожидание апдейтов (long polling)
  function waitForUpdates(timeoutSec, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      let timer;
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', done);
        resolve();
      };
      timer = setTimeout(done, Math.max(0, timeoutSec) * 1000);
      signal?.addEventListener?.('abort', done, { once: true });
      waiters.push(done);
    });
  }

  async function getUpdates(p, signal) {
    const offset = p.offset ?? 0;
    // подтверждённые апдейты (update_id < offset) удаляем
    while (queue.length && queue[0].update_id < offset) queue.shift();
    if (!queue.length && p.timeout > 0) await waitForUpdates(p.timeout, signal);
    while (queue.length && queue[0].update_id < offset) queue.shift();
    return queue.slice(0, p.limit || 100);
  }

  const methods = {
    getMe: () => me,
    getUpdates,
    deleteWebhook: () => true,
    close: () => true,
    logOut: () => true,

    async setMyCommands(p) {
      await tg.setMyCommands({
        commands: (p.commands ?? []).map((c) => ({ _: 'botCommand', command: c.command, description: c.description })),
      });
      return true;
    },

    async sendMessage(p) {
      const msg = await tg.sendText(p.chat_id, toInputText(p.text, p.parse_mode, thtml), {
        replyMarkup: toReplyMarkup(p.reply_markup, BotKeyboard),
        replyTo: replyToId(p),
        disableWebPreview: p.link_preview_options?.is_disabled ?? p.disable_web_page_preview,
      });
      return messageToApi(msg);
    },

    async editMessageText(p) {
      const msg = await tg.editMessage({
        chatId: p.chat_id,
        message: p.message_id,
        text: toInputText(p.text, p.parse_mode, thtml),
        replyMarkup: toReplyMarkup(p.reply_markup, BotKeyboard),
      });
      return messageToApi(msg);
    },

    async editMessageReplyMarkup(p) {
      // без replyMarkup mtcute удаляет клавиатуру — как Bot API с пустой разметкой
      const msg = await tg.editMessage({
        chatId: p.chat_id,
        message: p.message_id,
        replyMarkup: toReplyMarkup(p.reply_markup, BotKeyboard),
      });
      return messageToApi(msg);
    },

    async answerCallbackQuery(p) {
      const id = String(p.callback_query_id);
      const q = callbacks.get(id) ?? Long.fromString(id);
      callbacks.delete(id);
      await tg.answerCallbackQuery(q, {
        ...(p.text ? { text: p.text } : {}),
        alert: Boolean(p.show_alert),
        ...(p.cache_time ? { cacheTime: p.cache_time } : {}),
      });
      return true;
    },
  };

  /** Трансформер grammY: перехватывает все вызовы Bot API */
  const transformer = async (_prev, method, payload, signal) => {
    const fn = methods[method];
    if (!fn) {
      return { ok: false, error_code: 501, description: `Метод ${method} не поддерживается при работе через MTProto proxy` };
    }
    try {
      const result = await fn(payload ?? {}, signal);
      return { ok: true, result };
    } catch (e) {
      const code = Number.isInteger(e?.code) ? e.code : 400;
      return { ok: false, error_code: code, description: e?.message ?? String(e) };
    }
  };

  return {
    transformer,
    me,
    async stop() {
      wake();
      try { await tg.destroy(); } catch { /* ignore */ }
    },
  };
}
