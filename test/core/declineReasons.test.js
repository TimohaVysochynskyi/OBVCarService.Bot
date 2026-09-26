import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../helpers/repo.js';
import * as dr from '../../src/core/declineReasons.js';
import * as db from '../../src/core/dealBlocker.js';

const dbSrc = readSrc('core/dealBlocker.js');
const store = readSrc('core/store.js');
const dyn = readSrc('bot/dynamics.js');

test('три бакети відмов', () => {
  assert.deepEqual(db.DEAL_BLOCKERS, ['no_slot', 'no_parts', 'out_of_scope']);
});

test('у кожного бакета є повний і короткий підпис', () => {
  for (const b of db.DEAL_BLOCKERS) {
    assert.ok(db.BLOCKER_LABELS[b], `нема підпису ${b}`);
    assert.ok(db.BLOCKER_COLUMNS[b]);
  }
});

test('колонки «Динаміки» лишились вузькими і НЕ беруть підписи з BLOCKER_COLUMNS', () => {
  assert.match(dyn, /"Черга"\.padStart\(5\)/);
  assert.match(dyn, /"Профіль"\.padStart\(7\)/);
});

test('у кожного бакета є довга назва для картки у звіті', () => {
  for (const b of db.DEAL_BLOCKERS) assert.ok(db.BLOCKER_TITLES[b], `нема довгої назви для ${b}`);
});

test('ключі причин унікальні', () => {
  const keys = dr.DECLINE_REASONS.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('підписи причин унікальні', () => {
  const labels = dr.DECLINE_REASONS.map((r) => r.label);
  assert.equal(new Set(labels).size, labels.length);
});

test('кожна причина СТО належить наявному бакету', () => {
  for (const r of dr.SERVICE_REASONS) {
    assert.ok(db.DEAL_BLOCKERS.includes(r.bucket), `причина ${r.key} вказує на неіснуючий бакет`);
  }
});

test('у кожного бакета є щонайменше одна причина', () => {
  for (const b of db.DEAL_BLOCKERS) assert.ok(dr.reasonsOfBucket(b).length > 0, `у бакета ${b} нема причин`);
});

test('причини клієнта не мають бакета СТО', () => {
  for (const r of dr.CLIENT_REASONS) assert.equal(r.bucket, null);
});

test('сторона причини визначається правильно', () => {
  assert.equal(dr.reasonSide('price'), 'client');
  assert.equal(dr.reasonSide('busy'), 'service');
});

test('деталі ведуть у свій бакет', () => {
  assert.equal(dr.bucketOfReason('no_part'), 'no_parts');
});

test('невідома причина не має підпису', () => {
  assert.equal(dr.reasonLabel('вигадана'), null);
});

test('схема обмежує причину списком', () => {
  assert.match(dbSrc, /reason: \{ type: 'string', enum: \['', \.\.\.SERVICE_REASON_KEYS\] \}/);
});

test('причина з чужого бакета відкидається кодом', () => {
  assert.match(dbSrc, /const reason = bucketOfReason\(raw\.reason\) === blocker \? raw\.reason : null;/);
});

test('усі виходи «блокера немає» несуть порожню причину', () => {
  assert.equal((dbSrc.match(/reason: null/g) || []).length, 5);
});

test('успішний вихід несе причину', () => {
  assert.match(dbSrc, /return \{ blocker, reason, quote, start: hit\.start, end: hit\.end \};/);
});

test('SQL-фільтр знає три бакети', () => {
  assert.match(store, /BLOCKED_FILTER = `deal_blocker IN \('no_slot','no_parts','out_of_scope'\)`/);
});

test('зворотний фільтр NULL-безпечний', () => {
  assert.match(store, /NOT_BLOCKED_FILTER = `\(deal_blocker IS NULL OR deal_blocker NOT IN \('no_slot','no_parts','out_of_scope'\)\)`/);
});

test('обидві колонки причин створюються', () => {
  assert.match(store, /deal_blocker_reason TEXT/);
  assert.match(store, /client_decline_reason TEXT/);
});

test('лічильник «нема деталей» є в агрегаті', () => {
  assert.match(store, /blockedNoParts/);
});

test('динаміка не губить деталі в колонці Профіль', () => {
  assert.match(dyn, /blockedOutOfScope \|\| 0\) \+ \(b\.blockedNoParts \|\| 0\)/);
});

test('«не перевіряли» і далі показується прочерком, а не нулем', () => {
  assert.match(dyn, /b\.blockedOutOfScope == null && b\.blockedNoParts == null\s*\?\s*null/);
});

test('клієнтський класифікатор обмежений своїм списком', () => {
  assert.match(readSrc('core/clientDecline.js'), /enum: CLIENT_REASON_KEYS/);
});

test('доказ не вимагається лише там, де його не буває', () => {
  assert.match(readSrc('core/clientDecline.js'), /NO_EVIDENCE_NEEDED = \['unclear', 'no_answer'\]/);
});

test('класифікація причини клієнта відтворювана', () => {
  assert.match(readSrc('core/clientDecline.js'), /temperature: 0/);
});
