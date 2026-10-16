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

  transaction(fn) {
    return (...args) => {
      this.db.exec('BEGIN');
      try {
        const res = fn(...args);
        this.db.exec('COMMIT');
        return res;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    };
  }

  close() {
    this.db.close();
  }
}
