// Убираем предупреждение «SQLite is an experimental feature» от node:sqlite,
// остальные предупреждения выводятся как обычно.
const isSqliteWarning = (w) => w?.name === 'ExperimentalWarning' && /sqlite/i.test(w?.message ?? '');

const defaultListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (isSqliteWarning(w)) return;
  for (const l of defaultListeners) l.call(process, w);
});
