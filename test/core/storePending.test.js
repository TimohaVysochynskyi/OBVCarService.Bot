import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../helpers/repo.js';

const query = readSrc('core/store.js').match(/async function getPendingCalls\(\)[\s\S]*?\n\}/)[0];

test('getPendingCalls вибирає всі 9 полів, включно з lastError', () => {
  for (const f of ['generalCallId', 'internalNumber', 'managerName', 'startTime', 'durationSec',
    'clientNumber', 'clientName', 'attempts', 'lastError']) {
    assert.ok(query.includes(f), `getPendingCalls не вибирає ${f}`);
  }
});

test('ретрай відновлює клас помилки саме з lastError', () => {
  assert.match(readSrc('jobs/processCalls.js'), /reviveError\(call\.lastError\)/);
});
