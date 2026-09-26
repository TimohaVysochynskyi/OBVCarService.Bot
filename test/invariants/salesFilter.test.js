import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, allRepos } from '../helpers/repo.js';

const store = allRepos();
const filters = readSrc('platform/db/filters.js');
const successCounts = [...store.matchAll(/FILTER \(WHERE is_success([^)]*)\)/g)];

test('голого FILTER (WHERE is_success) у store немає', () => {
  assert.ok(!/FILTER \(WHERE is_success\)/.test(store),
    'записів вийде більше, ніж угод: is_success переживає перекласифікацію в непродажні');
});

test('кожен підрахунок записів обмежений тим самим фільтром, що й угоди', () => {
  assert.ok(successCounts.length > 0, 'підрахунків записів не знайдено — перевірка втратила предмет');
  const offenders = successCounts.filter((m) => !m[1].includes('SALES_FILTER')).map((m) => m[0]);
  assert.deepEqual(offenders, [], `підрахунок записів без SALES_FILTER: ${offenders.join(' | ')}`);
});

test('SALES_FILTER оголошений один раз і саме як умова, а не як перелік винятків', () => {
  assert.equal((store.match(/const SALES_FILTER =/g) || []).length, 1);
  assert.match(filters, /const SALES_FILTER = `\(call_purpose = 'sales' OR call_purpose IS NULL\)`/);
});

test('reachableCount навмисно лишає OR is_success', () => {
  assert.match(store, /OR is_success/);
});
