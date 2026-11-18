import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, readSrc, sliceFunction } from '../helpers/repo.js';

const src = readSrc('scripts/backfillComplaints.js');
const main = sliceFunction(src, 'async function main');

function guard(spentUsd, budget) {
  const fn = new Function(
    'usageReport',
    'BUDGET_USD',
    `${sliceFunction(src, 'function budgetSpent')}
return budgetSpent;`
  )(() => ({ usd: spentUsd }), budget);
  return fn();
}

test('межа витрат рахується з ФАКТИЧНОЇ вартості, а не з оцінки', () => {
  assert.match(sliceFunction(src, 'function budgetSpent'), /usageReport\(\)\.usd/);
});

test('до межі прогін триває, на межі спиняється', () => {
  assert.equal(guard(0.42, 1), false);
  assert.equal(guard(0.999, 1), false);
  assert.equal(guard(1, 1), true);
  assert.equal(guard(1.4, 1), true);
});

test('невідома ціна моделі не зупиняє прогін мовчки', () => {
  assert.equal(guard(null, 1), false);
});

test('перевірка стоїть ПЕРЕД запитом до моделі, а не після', () => {
  const stop = main.indexOf('budgetSpent()');
  const ask = main.indexOf('detectClientComplaint');
  assert.ok(stop > 0 && stop < ask, 'межу перевіряють уже після того, як заплатили');
  assert.match(main, /break;/);
});

test('зупинка на межі не ламає ідемпотентність: решта лишається неперевіреною', () => {
  assert.match(main, /has_complaint IS NULL/);
  const query = sliceFunction(readSrc('features/analysis/repo.js'), 'async function getCallsMissingComplaint');
  assert.match(query, /has_complaint IS NULL/);
});

test('дефолтна межа — долар, і її видно в оголошенні', () => {
  assert.match(src, /const DEFAULT_BUDGET_USD = 1;/);
  assert.match(src, /flagValue\('--budget'\)/);
});

test('скрипт оголошений у package.json', () => {
  const pkg = JSON.parse(readRepo('package.json'));
  assert.equal(pkg.scripts['backfill:complaints'], 'node src/scripts/backfillComplaints.js');
});
