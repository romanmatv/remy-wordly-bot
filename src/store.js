import { insertWordsStmt, wordRow } from './db.js';

/** Слой доступа к данным поверх SQLite */
export function createStore(db) {
  const q = {
    getGame: db.prepare('SELECT * FROM games WHERE chat_id = ?'),
    setGame: db.prepare(`
      INSERT INTO games (chat_id, type, state, started_by, started_at)
      VALUES (@chat_id, @type, @state, @started_by, @started_at)
      ON CONFLICT (chat_id) DO UPDATE SET type = excluded.type, state = excluded.state,
        started_by = excluded.started_by, started_at = excluded.started_at`),
    updateState: db.prepare('UPDATE games SET state = ? WHERE chat_id = ?'),
    delGame: db.prepare('DELETE FROM games WHERE chat_id = ?'),
    gamesByType: db.prepare('SELECT * FROM games WHERE type = ?'),

    clearUsed: db.prepare('DELETE FROM used_words WHERE chat_id = ?'),
    addUsed: db.prepare('INSERT OR IGNORE INTO used_words (chat_id, norm) VALUES (?, ?)'),
    isUsed: db.prepare('SELECT 1 FROM used_words WHERE chat_id = ? AND norm = ?'),

    addPoint: db.prepare(`
      INSERT INTO scores (chat_id, user_id, game_type, points) VALUES (?, ?, ?, ?)
      ON CONFLICT (chat_id, user_id, game_type) DO UPDATE SET points = points + excluded.points`),
    scores: db.prepare(`
      SELECT s.user_id, s.game_type, s.points, u.name, u.username
      FROM scores s LEFT JOIN users u ON u.user_id = s.user_id
      WHERE s.chat_id = ? AND s.points > 0`),
    scoresElsewhere: db.prepare(`
      SELECT s.user_id, s.game_type, SUM(s.points) AS points, u.name, u.username
      FROM scores s LEFT JOIN users u ON u.user_id = s.user_id
      WHERE s.chat_id <> @chat AND s.points > 0
        AND (
          EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = @chat AND m.user_id = s.user_id)
          OR EXISTS (SELECT 1 FROM scores c WHERE c.chat_id = @chat AND c.user_id = s.user_id)
        )
      GROUP BY s.user_id, s.game_type`),
    addMember: db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)'),
    clearScores: db.prepare('DELETE FROM scores WHERE chat_id = ?'),

    upsertUser: db.prepare(`
      INSERT INTO users (user_id, name, username, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, username = excluded.username,
        updated_at = excluded.updated_at`),

    getPending: db.prepare('SELECT * FROM pending WHERE chat_id = ? AND user_id = ?'),
    setPending: db.prepare(`
      INSERT INTO pending (chat_id, user_id, action, category, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (chat_id, user_id) DO UPDATE SET action = excluded.action,
        category = excluded.category, created_at = excluded.created_at`),
    delPending: db.prepare('DELETE FROM pending WHERE chat_id = ? AND user_id = ?'),

    findWord: db.prepare('SELECT * FROM words WHERE category = ? AND norm = ?'),
    findWordAnyCat: db.prepare('SELECT * FROM words WHERE norm = ?'),
    delWordNorm: db.prepare('DELETE FROM words WHERE norm = ?'),
    hasFreeWordOnLetter: db.prepare(`
      SELECT 1 FROM words w
      WHERE w.category = ? AND w.first_letter = ? AND w.single = 1
        AND NOT EXISTS (SELECT 1 FROM used_words u WHERE u.chat_id = ? AND u.norm = w.norm)
      LIMIT 1`),
  };
  const insertWord = insertWordsStmt(db);

  return {
    db,

    // --- Игры ---
    getGame(chatId) {
      const row = q.getGame.get(chatId);
      return row ? { ...row, state: JSON.parse(row.state) } : null;
    },
    startGame(chatId, type, state, userId) {
      db.transaction(() => {
        q.clearUsed.run(chatId);
        q.setGame.run({
          chat_id: chatId, type, state: JSON.stringify(state),
          started_by: userId ?? null, started_at: Date.now(),
        });
      })();
    },
    saveState(chatId, state) {
      q.updateState.run(JSON.stringify(state), chatId);
    },
    stopGame(chatId) {
      db.transaction(() => {
        q.delGame.run(chatId);
        q.clearUsed.run(chatId);
      })();
    },
    gamesOfType(type) {
      return q.gamesByType.all(type).map((r) => ({ ...r, state: JSON.parse(r.state) }));
    },

    // --- Использованные слова ---
    markUsed(chatId, norm) { q.addUsed.run(chatId, norm); },
    isUsed(chatId, norm) { return !!q.isUsed.get(chatId, norm); },

    // --- Слова ---
    findWord(category, norm) { return q.findWord.get(category, norm); },
    findWordAnyCategory(norm) { return q.findWordAnyCat.all(norm); },
    hasFreeWordOnLetter(chatId, category, letter) {
      return !!q.hasFreeWordOnLetter.get(category, letter, chatId);
    },
    /** Случайное неиспользованное однословное слово из указанных категорий */
    randomWord(chatId, categories, letter = null) {
      const ph = categories.map(() => '?').join(',');
      const sql = `
        SELECT * FROM words w
        WHERE w.category IN (${ph}) AND w.single = 1
          ${letter ? 'AND w.first_letter = ?' : ''}
          AND NOT EXISTS (SELECT 1 FROM used_words u WHERE u.chat_id = ? AND u.norm = w.norm)
        ORDER BY RANDOM() LIMIT 1`;
      const args = [...categories, ...(letter ? [letter] : []), chatId];
      return db.prepare(sql).get(...args);
    },
    addWord(category, word, userId) {
      const row = wordRow(category, word, userId);
      if (!row) return { ok: false, reason: 'empty' };
      const res = insertWord.run(row);
      return res.changes ? { ok: true, row } : { ok: false, reason: 'exists', row };
    },
    countWords() {
      return db.prepare('SELECT COUNT(*) AS n FROM words').get().n;
    },
    /** Удаляет ВСЕ слова из словаря. Возвращает количество удалённых. */
    deleteAllWords() {
      return db.prepare('DELETE FROM words').run().changes;
    },
    deleteWord(norm) {
      const rows = q.findWordAnyCat.all(norm);
      if (rows.length) q.delWordNorm.run(norm);
      return rows;
    },

    // --- Счёт ---
    addPoint(chatId, userId, gameType, points = 1) {
      q.addPoint.run(chatId, userId, gameType, points);
    },
    getScores(chatId) { return q.scores.all(chatId); },
    /** Суммарный счёт участников этого чата во всех ОСТАЛЬНЫХ чатах */
    getScoresElsewhere(chatId) { return q.scoresElsewhere.all({ chat: chatId }); },
    clearScores(chatId) { q.clearScores.run(chatId); },

    // --- Пользователи ---
    rememberUser(user) {
      if (!user) return;
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id);
      q.upsertUser.run(user.id, name, user.username ?? null, Date.now());
    },

    rememberMember(chatId, userId) { q.addMember.run(chatId, userId); },

    // --- Ожидание ввода ---
    getPending(chatId, userId) { return q.getPending.get(chatId, userId); },
    setPending(chatId, userId, action, category = null) {
      q.setPending.run(chatId, userId, action, category, Date.now());
    },
    clearPending(chatId, userId) { q.delPending.run(chatId, userId); },
  };
}
