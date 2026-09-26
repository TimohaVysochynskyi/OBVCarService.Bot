import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../helpers/repo.js';
import { CALL_PURPOSES, NON_SALES_PURPOSES, PURPOSE_LABELS, isSales } from '../../src/core/callPurpose.js';

const store = readSrc('core/store.js');

test('чотири категорії', () => {
  assert.deepEqual(CALL_PURPOSES, ['sales', 'info', 'other', 'personal']);
});

test('непродажні = три', () => {
  assert.deepEqual(NON_SALES_PURPOSES, ['info', 'other', 'personal']);
});

test('угоди не серед непродажних', () => {
  assert.ok(!NON_SALES_PURPOSES.includes('sales'));
});

test('іконка кожної категорії унікальна', () => {
  const icons = Object.values(PURPOSE_LABELS).map((l) => l.icon);
  assert.equal(new Set(icons).size, icons.length);
});

test('у кожної категорії є підпис', () => {
  for (const p of CALL_PURPOSES) assert.ok(PURPOSE_LABELS[p]?.plural, `нема підпису для ${p}`);
});

test('NULL і далі рахується як угода', () => {
  assert.equal(isSales(null), true);
});

test('особистий не угода', () => {
  assert.equal(isSales('personal'), false);
});

test('SALES_FILTER виключає особисті', () => {
  assert.match(store, /const SALES_FILTER = `\(call_purpose = 'sales' OR call_purpose IS NULL\)`/);
});

test('обидва infoCount рахують особисті', () => {
  assert.equal((store.match(/call_purpose IN \('info','other','personal'\)/g) || []).length, 2);
});

test('старої двійки в store не лишилось', () => {
  assert.ok(!/IN \('info','other'\)/.test(store));
});

test('гейти в analyze/segments/archive читають спільний список', () => {
  for (const f of ['bot/analyze.js', 'bot/segments.js', 'bot/archive.js']) {
    const src = readSrc(f);
    assert.match(src, /NON_SALES_PURPOSES/, `${f} не використовує спільний список`);
    assert.ok(!/'info' \|\| c\.callPurpose === 'other'/.test(src));
    assert.ok(!/p === "other" \|\| p === "info"/.test(src));
  }
});

test('архів: 5 вкладок, особисті серед них', () => {
  const cats = [...readSrc('bot/archive.js').matchAll(/key: "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(cats, ['sales', 'info', 'personal', 'other', 'none']);
});

test('analyzeCall бере таксономію зі спільного файлу', () => {
  assert.match(readSrc('core/analyzeCall.js'), /import \{ CALL_PURPOSES, purposeRules \} from '\.\/callPurpose\.js'/);
});

test('локальної копії списку категорій більше немає', () => {
  assert.ok(!/const CALL_PURPOSES = \[/.test(readSrc('core/analyzeCall.js')));
});

test('схема моделі обмежена тим самим списком', () => {
  assert.match(readSrc('core/analyzeCall.js'), /enum: CALL_PURPOSES/);
});

test('промпт бере правила категорій із реєстру', () => {
  assert.match(readSrc('core/analyzeCall.js'), /\$\{await purposeRules\(\)\}/);
});

test('перекласифікатор НЕ може повернути «угода»', () => {
  assert.match(readSrc('core/classifyPersonal.js'), /enum: NON_SALES_PURPOSES/);
});

test('перекласифікація відтворювана', () => {
  assert.match(readSrc('core/classifyPersonal.js'), /temperature: 0/);
});
