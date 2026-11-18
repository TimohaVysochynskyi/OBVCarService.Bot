import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, sliceFunction } from '../helpers/repo.js';

const repo = readSrc('features/analysis/repo.js');
const filters = readSrc('platform/db/filters.js');

const SCOPED = [
  ['async function getCallsMissingPurpose', 'backfillPurpose.js'],
  ['async function getSalesCallsWithSegments', 'rescoreSales.js'],
  ['async function getCallsMissingBlocker', 'backfillBlockers.js'],
  ['async function getUnexplainedDeclines', 'backfillDeclines.js'],
];

test('фрагмент «лише separate» оголошений РІВНО ОДИН раз', () => {
  assert.match(filters, /const SEPARATE_STT = `stt_mode = 'separate'`;/);
  const copies = ['features/analysis/repo.js', 'features/reporting/repo.js', 'features/ingest/repo.js']
    .filter((f) => /stt_mode = 'separate'/.test(readSrc(f)));
  assert.deepEqual(copies, [], `умова продубльована в ${copies.join(', ')}`);
});

test('кожен перерахунок уміє звузитись до вже перероблених дзвінків', () => {
  for (const [signature] of SCOPED) {
    const fn = sliceFunction(repo, signature);
    assert.match(fn, /separateOnly/, `${signature} не приймає звуження`);
    assert.match(fn, /sttScope\(separateOnly\)/, `${signature} не застосовує звуження в SQL`);
  }
});

test('звуження вимикається за замовчуванням — беклог лишається повним', () => {
  for (const [signature] of SCOPED) {
    assert.match(sliceFunction(repo, signature), /separateOnly = false/, `${signature} звужує завжди`);
  }
  const scope = sliceFunction(filters, 'const sttScope');
  assert.match(scope, /separateOnly \?/);
});

test('кожен скрипт віддає прапорець у свій запит', () => {
  for (const [, file] of SCOPED) {
    const src = readSrc(`scripts/${file}`);
    assert.match(src, /const SEPARATE_ONLY = process\.argv\.includes\('--separate-only'\);/, `${file} без прапорця`);
    assert.match(src, /separateOnly: SEPARATE_ONLY/, `${file} не передає прапорець у вибірку`);
  }
});
