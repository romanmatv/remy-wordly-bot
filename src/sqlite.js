/**
 * Тонкая обёртка над встроенным модулем node:sqlite (Node.js >= 22.13),
 * повторяющая нужную часть API better-sqlite3: prepare/exec/pragma/transaction.
 * Встроенный модуль не требует компиляции нативных библиотек.
 */
import { DatabaseSync } from 'node:sqlite';

export default class Database {
  constructor(file) {
    this.db = new DatabaseSync(file);
  }

  exec(sql) {
    this.db.exec(sql);
  }

  pragma(sql) {
    this.db.exec(`PRAGMA ${sql}`);
  }

  prepare(sql) {
    const st = this.db.prepare(sql);
    // именованные параметры передаём как { '@name': value }
    const fix = (args) =>
      args.map((a) =>
        a && typeof a === 'object' && !Array.isArray(a)
          ? Object.fromEntries(Object.entries(a).map(([k, v]) => ['@' + k, v]))
          : a,
      );
    return {
      run: (...args) => st.run(...fix(args)),
      get: (...args) => st.get(...fix(args)),
      all: (...args) => st.all(...fix(args)),
    };
  }

  /**
   * Как в better-sqlite3: возвращает функцию, выполняющую fn в транзакции.
   * Вложенные вызовы оформляются через SAVEPOINT.
   */
  transaction(fn) {
    return (...args) => {
      const depth = this._txDepth ?? 0;
      const sp = `sp_${depth}`;
      this.db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this._txDepth = depth + 1;
      try {
        const res = fn(...args);
        this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return res;
      } catch (e) {
        this.db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      } finally {
        this._txDepth = depth;
      }
    };
  }

  close() {
    this.db.close();
  }
}
