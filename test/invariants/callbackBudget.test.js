import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SRC, readSrc, bytes } from '../helpers/repo.js';
import { PERSONAL_OPERATORS, SHARED_EXTENSIONS } from '../../src/core/phoneLines.js';

const LIMIT = 64;
const MIN_ROOM_FOR_VALUES = 16;

const files = fs.readdirSync(`${SRC}bot`).filter((f) => f.endsWith('.js'));
const CALLBACK_ARG = /\.text\(\s*(?:[^,()]|\([^()]*\))*,\s*(`[^`]*`|'[^']*'|"[^"]*")\s*\)/g;

const callbacks = [];
for (const file of files) {
  for (const m of readSrc(`bot/${file}`).matchAll(CALLBACK_ARG)) {
    callbacks.push({ file, raw: m[1] });
  }
}
const literals = callbacks.filter((c) => !c.raw.startsWith('`')).map((c) => ({ ...c, value: c.raw.slice(1, -1) }));
const templates = callbacks.filter((c) => c.raw.startsWith('`'))
  .map((c) => ({ ...c, skeleton: c.raw.slice(1, -1).replace(/\$\{[^}]*\}/g, '') }));

const reportSrc = readSrc('bot/report.js');
const expandSrc = reportSrc.slice(reportSrc.indexOf('const MODE_CODE'), reportSrc.indexOf('async function deliverReport'));
const expandKeyOf = new Function('noteIssue', `${expandSrc}; return expandKeyOf;`)(() => ({ catch() {} }));
const start = new Date('2026-09-19T00:00:00Z');
const end = new Date('2026-12-31T23:59:59Z');
const operators = [...Object.values(PERSONAL_OPERATORS), ...SHARED_EXTENSIONS];

test('кнопки з callback_data справді знайдені', () => {
  assert.ok(callbacks.length >= 40, `знайдено лише ${callbacks.length} кнопок — перевірка втратила предмет`);
  assert.ok(literals.length > 0 && templates.length > 0);
});

test('жодна незмінна callback_data не довша за 64 байти', () => {
  const over = literals.filter((c) => bytes(c.value) > LIMIT).map((c) => `${c.file}: ${c.value}`);
  assert.deepEqual(over, [], `перевищення ліміту Telegram: ${over.join(', ')}`);
});

test('у кожної складеної callback_data лишається місце під значення', () => {
  const tight = templates
    .filter((c) => LIMIT - bytes(c.skeleton) < MIN_ROOM_FOR_VALUES)
    .map((c) => `${c.file}: ${c.raw} (${bytes(c.skeleton)} Б скелета)`);
  assert.deepEqual(tight, [], `на значення лишається менше ${MIN_ROOM_FOR_VALUES} байтів: ${tight.join(', ')}`);
});

test('ключ розгортання звіту вкладається в ліміт для кожного реального менеджера', () => {
  for (const name of operators) {
    for (const mode of ['daily', 'range', 'range_reuse', 'live']) {
      for (const prefix of ['report:exp:', 'report:phr:']) {
        const data = prefix + expandKeyOf(name, start, end, mode);
        assert.ok(bytes(data) <= LIMIT, `${data} = ${bytes(data)} Б`);
      }
    }
  }
});

test('кнопки архіву вкладаються в ліміт на найдовших реальних значеннях', () => {
  for (const name of operators) {
    const call = `arch:call:${'9'.repeat(13)}:9999:personal`;
    const back = `arch:go:9999:personal:${name}`;
    assert.ok(bytes(call) <= LIMIT, `${call} = ${bytes(call)} Б`);
    assert.ok(bytes(back) <= LIMIT, `${back} = ${bytes(back)} Б`);
  }
});

test('перевищення бюджету логується як інцидент, а не мовчить', () => {
  assert.match(reportSrc, /noteIssue\('TG-CBDATA'/);
  assert.match(reportSrc, /const CALLBACK_LIMIT = 64;/);
});
