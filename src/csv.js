import fs from 'node:fs';

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  // первая строка — заголовок
  return text.split(/\r?\n/).slice(1).filter((l) => l.trim() !== '');
}

/** city.csv: разделитель «;», берём последний столбец, двойные кавычки убираем */
export function parseCities(file) {
  return readLines(file)
    .map((line) => {
      const cols = line.split(';');
      return cols[cols.length - 1].replace(/"/g, '').trim();
    })
    .filter(Boolean);
}

/** nouns.csv / verbs.csv: разделитель — табуляция, берём первый столбец */
export function parseFirstColumnTsv(file) {
  return readLines(file)
    .map((line) => line.split('\t')[0].replace(/"/g, '').trim())
    .filter(Boolean);
}
