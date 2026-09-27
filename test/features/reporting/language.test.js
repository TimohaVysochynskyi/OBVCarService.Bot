import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, readJson } from '../../helpers/repo.js';

const DEF = readJson('features/prompts/defaults.json');
const text = (k) => DEF[k].join('\n');

test('мова зафіксована в ОБОХ промптах, що пишуть текст для людини', () => {
  const withRule = Object.keys(DEF).filter((k) => /МОВА: пиши claim/.test(text(k)));
  assert.deepEqual(withRule.sort(), ['reportGuidance', 'reportMerge']);
});

test('перший прохід (пошук патернів) несе правило мови', () => {
  assert.match(text('reportGuidance'), /МОВА: пиши claim/);
});

test('другий прохід (зведення за період) несе правило мови', () => {
  assert.match(text('reportMerge'), /МОВА: пиши claim/);
});

test('цитати явно виведені з-під правила — доказ мусить лишитись дослівним', () => {
  assert.match(text('reportMerge'), /Цитати з розмов не перекладай/);
});

test('зведення й далі послідовне', () => {
  assert.ok(!/mergeFindings\(name, errors\), *\n? *mergeFindings/.test(readSrc('features/reporting/globalReportData.js')));
});
