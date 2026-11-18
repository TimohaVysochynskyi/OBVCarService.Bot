import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, sliceFunction, migrationsSql } from '../../helpers/repo.js';
import { normalizeLinePhone } from '../../../src/domain/call/phoneLines.js';
import { formatLinePhone } from '../../../src/features/operators/display.js';

const binotel = readSrc('platform/binotel/client.js');
const repo = readSrc('features/ingest/repo.js');

const pbxNumberOf = new Function(
  'normalizeLinePhone',
  `${sliceFunction(binotel, 'function pbxNumberOf')}
return pbxNumberOf;`
)(normalizeLinePhone);

test('номер лінії зводиться до однієї форми, хоч би як його віддав Binotel', () => {
  for (const raw of ['0754738200', '380754738200', '+38 (075) 473-82-00', '754738200', '80754738200']) {
    assert.equal(normalizeLinePhone(raw), '0754738200', `не звівся: ${raw}`);
  }
});

test('нерозпізнаний рядок не видається за номер', () => {
  assert.equal(normalizeLinePhone('abc'), null);
  assert.equal(normalizeLinePhone(''), null);
  assert.equal(normalizeLinePhone(null), null);
});

test('формат для читача рахується з тієї самої нормалізації, а не власним розбором', () => {
  assert.equal(formatLinePhone('380754738200'), '075 473 82 00');
  assert.match(readSrc('features/operators/display.js'), /normalizeLinePhone\(raw\)/);
});

test('pbxNumberData береться з кожного дзвінка і нормалізується', () => {
  assert.equal(pbxNumberOf({ pbxNumberData: { number: '380734738200' } }), '0734738200');
  assert.equal(pbxNumberOf({ pbxNumberData: { number: '0734738200', name: 'Київстар' } }), '0734738200');
});

test('дзвінок без цього поля не ламає розбір і не вигадує номера', () => {
  assert.equal(pbxNumberOf({}), null);
  assert.equal(pbxNumberOf({ pbxNumberData: {} }), null);
  assert.equal(pbxNumberOf({ pbxNumberData: { number: '' } }), null);
});

test('нестандартний номер зберігається як є, а не викидається', () => {
  assert.equal(pbxNumberOf({ pbxNumberData: { number: '4039' } }), '4039');
});

test('номер лінії доїжджає від Binotel до рядка в calls', () => {
  assert.match(binotel, /pbxNumber: pbxNumberOf\(c\)/);
  const save = sliceFunction(repo, 'async function saveCall');
  assert.match(save, /pbx_number/);
  assert.match(save, /call\.pbxNumber \?\? null/);
});

test('черга ретраю теж несе номер — інакше він зникне після повтору, як було з direction', () => {
  const upsert = sliceFunction(repo, 'async function upsertPending');
  assert.match(upsert, /pbx_number/);
  const pending = sliceFunction(repo, 'async function getPendingCalls');
  assert.match(pending, /pbx_number AS "pbxNumber"/);
});

test('колонка заведена міграцією в обох таблицях', () => {
  const sql = migrationsSql();
  assert.match(sql, /ALTER TABLE calls ADD COLUMN IF NOT EXISTS pbx_number TEXT;/);
  assert.match(sql, /ALTER TABLE pending_calls ADD COLUMN IF NOT EXISTS pbx_number TEXT;/);
});

test('беклог проставляє номер лише там, де його ще немає', () => {
  const update = sliceFunction(repo, 'async function updatePbxNumberIfMissing');
  assert.match(update, /pbx_number IS NULL/);
  assert.match(update, /\$2::text IS NOT NULL/);
});

test('номер лінії НЕ використовується для визначення добавочного', () => {
  const process = readSrc('features/ingest/process.js');
  const resolve = sliceFunction(process, 'function knownManagerName');
  assert.ok(!/pbx/i.test(resolve), 'на вхідному це поле показує номер, який набрав КЛІЄНТ');
  const binotelLine = sliceFunction(binotel, 'function pbxNumberOf');
  assert.ok(!/internalNumber/.test(binotelLine));
});
