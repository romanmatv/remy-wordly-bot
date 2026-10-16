import { GAME_TYPES } from './config.js';
import { escapeHtml } from './normalize.js';

const ICONS = { nouns: '🔤', cities: '🏙', croc: '🐊' };

function displayName(r) {
  return escapeHtml(r.name || (r.username ? '@' + r.username : `id${r.user_id}`));
}

function ranking(map) {
  const list = [...map.values()].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  if (!list.length) return '  <i>пока никто не набрал очков</i>';
  const medals = ['🥇', '🥈', '🥉'];
  return list
    .map((p, i) => `  ${medals[i] ?? `${i + 1}.`} ${p.name} — <b>${p.points}</b>`)
    .join('\n');
}

/** Счёт чата по каждому виду игр + общий */
export function formatStats(store, chatId, title = '📊 <b>Счёт игроков</b>') {
  const rows = store.getScores(chatId);
  const byType = Object.fromEntries(Object.keys(GAME_TYPES).map((t) => [t, new Map()]));
  const total = new Map();

  for (const r of rows) {
    const name = displayName(r);
    const t = byType[r.game_type];
    if (t) t.set(r.user_id, { name, points: r.points });
    const prev = total.get(r.user_id) ?? { name, points: 0 };
    prev.points += r.points;
    total.set(r.user_id, prev);
  }

  const parts = [title, ''];
  for (const [type, label] of Object.entries(GAME_TYPES)) {
    parts.push(`${ICONS[type]} <b>${label}</b>`, ranking(byType[type]), '');
  }
  parts.push('🏆 <b>Общий счёт</b>', ranking(total));
  return parts.join('\n');
}

const SHORT = { nouns: 'Сущ.', cities: 'Города', croc: 'Крокодил' };

/**
 * Суммарный счёт участников текущего чата во всех остальных чатах.
 * Одна строка на игрока: всего и разбивка по видам игр.
 */
export function formatStatsElsewhere(store, chatId) {
  const players = new Map();
  for (const r of store.getScoresElsewhere(chatId)) {
    const p = players.get(r.user_id) ?? { name: displayName(r), total: 0, byType: {} };
    p.byType[r.game_type] = (p.byType[r.game_type] ?? 0) + r.points;
    p.total += r.points;
    players.set(r.user_id, p);
  }

  const title = '🌐 <b>В других чатах (суммарно)</b>';
  const list = [...players.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  if (!list.length) return `${title}\n  <i>у игроков этого чата нет очков в других чатах</i>`;

  const lines = list.map((p, i) => {
    const parts = Object.keys(GAME_TYPES)
      .filter((t) => p.byType[t])
      .map((t) => `${SHORT[t]}: ${p.byType[t]}`)
      .join(' · ');
    return `  ${i + 1}. ${p.name} — <b>${p.total}</b> (${parts})`;
  });
  return [title, ...lines].join('\n');
}
