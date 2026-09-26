import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../helpers/repo.js';

const db = readSrc('core/dealBlocker.js');
const backfill = readSrc('scripts/backfillBlockers.js');
const catchBlock = db.match(/\} catch \(err\) \{[\s\S]*?\n {2}\}/)[0];
const skip = backfill.match(/if \(r\.unchecked\)[\s\S]*?continue;/)[0];

test('збій рецензента повертає unchecked', () => {
  assert.match(catchBlock, /unchecked: true/);
});

test('...і при цьому НЕ створює блокера', () => {
  assert.match(catchBlock, /blocker: NO_BLOCKER/);
});

test('законне відкидання рецензентом пишеться як перевірене', () => {
  assert.ok(!/unchecked/.test(db.match(/rejected by verifier[\s\S]{0,160}/)[0]));
});

test('«цитати немає» теж пишеться як перевірене', () => {
  assert.ok(!/unchecked/.test(db.match(/quote not found in a manager segment[\s\S]{0,160}/)[0]));
});

test('інжест на unchecked лишає NULL у БД', () => {
  assert.match(readSrc('jobs/processCalls.js'), /if \(blocker\.unchecked\) blocker = \{ blocker: null, quote: null \}/);
});

test('беклог на unchecked НЕ викликає setCallBlocker', () => {
  assert.ok(!/setCallBlocker/.test(skip));
});

test('...і не зʼїдає паузу між дзвінками', () => {
  assert.match(skip, /PAUSE_MS/);
});

test('підсумок прогону показує, скільки лишилось на потім', () => {
  assert.match(backfill, /не перевірено \(лишились NULL\)/);
});
