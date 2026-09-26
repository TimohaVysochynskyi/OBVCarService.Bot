import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, migrationsSql } from '../helpers/repo.js';
import { directionOf, DIRECTION_LABELS } from '../../src/core/callDirection.js';

const store = readSrc('core/store.js');
const schema = migrationsSql();
const script = readSrc('scripts/backfillDirection.js');

test('callType 0 → вхідний (рядком і числом)', () => {
  assert.equal(directionOf('0'), 'in');
  assert.equal(directionOf(0), 'in');
});

test('callType 1 → вихідний', () => {
  assert.equal(directionOf('1'), 'out');
  assert.equal(directionOf(1), 'out');
});

test('порожнє значення → null, а не хибний напрямок', () => {
  assert.equal(directionOf(''), null);
  assert.equal(directionOf(null), null);
  assert.equal(directionOf(undefined), null);
});

test('невідоме значення → null', () => {
  assert.equal(directionOf('7'), null);
  assert.equal(directionOf('abc'), null);
});

test('у кожного напрямку є назва й пояснення', () => {
  for (const k of ['in', 'out']) assert.ok(DIRECTION_LABELS[k]?.title && DIRECTION_LABELS[k]?.about);
});

test('колонка direction створюється в calls', () => {
  assert.match(schema, /ALTER TABLE calls ADD COLUMN IF NOT EXISTS direction TEXT;/);
});

test('...і в черзі ретраю', () => {
  assert.match(schema, /ALTER TABLE pending_calls ADD COLUMN IF NOT EXISTS direction TEXT;/);
});

test('нова колонка створюється ПІСЛЯ дропу легасі', () => {
  assert.ok(schema.indexOf('DROP COLUMN IF EXISTS call_type') < schema.indexOf('ADD COLUMN IF NOT EXISTS direction'));
});

test('нову колонку НЕ названо call_type', () => {
  assert.ok(!/ADD COLUMN IF NOT EXISTS call_type/.test(schema));
});

test('saveCall пише напрямок', () => {
  const save = store.match(/async function saveCall[\s\S]*?\n\}/)[0];
  assert.match(save, /\bdirection\b/);
  assert.match(save, /call\.direction \?\? null/);
});

test('upsertPending пише напрямок і нумерація параметрів зсунута коректно', () => {
  const pend = store.match(/async function upsertPending[\s\S]*?\n\}/)[0];
  assert.match(pend, /client_name, direction, attempts/);
  assert.match(pend, /last_error = \$9/);
});

test('черга ретраю ВІДДАЄ напрямок', () => {
  assert.match(store.match(/async function getPendingCalls[\s\S]*?\n\}/)[0], /direction,/);
});

test('екран дзвінка отримує напрямок', () => {
  assert.match(store.match(/async function getCallByGeneralId[\s\S]*?\n\}/)[0], /direction/);
});

test('беклог ідемпотентний — пише лише в порожні', () => {
  assert.match(store, /direction IS NULL AND \$2::text IS NOT NULL/);
});

test('інжест мапить напрямок із callType', () => {
  assert.match(readSrc('core/binotel.js'), /direction: directionOf\(c\.callType\)/);
});

test('processCalls прокидає напрямок у saveCall', () => {
  assert.match(readSrc('jobs/processCalls.js'), /direction: call\.direction \?\? null/);
});

test('архів читає підпис зі спільного файлу', () => {
  assert.match(readSrc('bot/archive.js'), /DIRECTION_LABELS\[c\.direction\]/);
});

test('старі рядки без напрямку кажуть про це прямо', () => {
  assert.match(readSrc('bot/archive.js'), /Напрямок дзвінка невідомий/);
});

test('беклог напрямку не імпортує ЖОДНОГО платного модуля', () => {
  const imports = [...script.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  const paid = ['analyzeCall', 'classifyCall', 'classifyPersonal', 'clientDecline', 'dealBlocker',
    'transcribe', 'elevenlabs', 'identifyManager', 'analyze.js', 'segments.js', 'http.js'];
  for (const i of imports) for (const c of paid) assert.ok(!i.includes(c), `беклог тягне платний модуль: ${i}`);
});

test('і не звертається до OpenAI напряму', () => {
  assert.ok(!script.includes('api.openai.com'));
});

test('увесь його світ — Binotel, база, словник напрямків і конфіг', () => {
  const imports = [...script.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(),
    ['../core/binotel.js', '../core/callDirection.js', '../core/store.js', '../shared/config.js']);
});

test('бере дані лише з лістингу Binotel', () => {
  assert.match(script, /listCallsForPeriod/);
});
