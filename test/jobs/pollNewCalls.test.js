import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../helpers/repo.js';

const poll = readSrc('jobs/pollNewCalls.js');
const fnSrc = poll.match(/const DEFAULT_OVERLAP_MIN[\s\S]*?function checkpointOverlapMs\(\)\s*\{[\s\S]*?\n\}/)[0];
const withEnv = (env) => new Function('process', `${fnSrc}; return checkpointOverlapMs();`)({ env });

const CRON = 15 * 60000;
const CALL_START = new Date(10 * CRON - 11000);
const TALK_MS = 120000;

function leaks(overlapMs) {
  let checkpoint = new Date(0);
  for (let i = 1; i <= 20; i += 1) {
    const end = new Date(i * CRON);
    const visible = end.getTime() >= CALL_START.getTime() + TALK_MS;
    if (visible && CALL_START >= checkpoint && CALL_START < end) return false;
    checkpoint = new Date(end.getTime() - overlapMs);
  }
  return true;
}

test('дефолт перекриття = 15 хв', () => {
  assert.equal(withEnv({}), 15 * 60000);
});

test('POLL_OVERLAP_MIN переважує', () => {
  assert.equal(withEnv({ POLL_OVERLAP_MIN: '5' }), 5 * 60000);
});

test('0 = вимкнути перекриття (стара поведінка)', () => {
  assert.equal(withEnv({ POLL_OVERLAP_MIN: '0' }), 0);
});

test('сміття в env → дефолт, а не NaN', () => {
  assert.equal(withEnv({ POLL_OVERLAP_MIN: 'дурня' }), 15 * 60000);
});

test('відʼємне перекриття відкидається', () => {
  assert.equal(withEnv({ POLL_OVERLAP_MIN: '-9' }), 15 * 60000);
});

test('чекпоінт ставиться на end мінус перекриття', () => {
  assert.match(poll, /setCheckpoint\(new Date\(end\.getTime\(\) - checkpointOverlapMs\(\)\)\)/);
});

test('старого setCheckpoint(end) в коді не лишилось', () => {
  assert.ok(!/await setCheckpoint\(end\)/.test(poll));
});

test('чекпоінт рухається ПІСЛЯ обробки діапазону', () => {
  assert.ok(/processCallsForRange\(start, end\)[\s\S]{0,300}setCheckpoint/.test(poll));
});

test('без перекриття дзвінок на межі губиться назавжди', () => {
  assert.equal(leaks(0), true);
});

test('з перекриттям 15 хв той самий дзвінок ловиться', () => {
  assert.equal(leaks(15 * 60000), false);
});
