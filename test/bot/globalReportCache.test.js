import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readSrc } from '../helpers/repo.js';

const src = readSrc('bot/globalReportData.js');
const hash = new Function('createHash', `${src.match(/function inputHash[\s\S]*?\n\}/)[0]}; return inputHash;`)(createHash);
const withoutName = new Function(`${src.match(/const IS_LETTER[\s\S]*?(?=function topFindings)/)[0]}; return withoutName;`)();

const a = [{ type: 'error', claim: 'перебиває', evidence: [{ callId: '1', quote: 'ось так' }] }];
const b = [{ type: 'error', claim: 'перебиває', evidence: [{ callId: '1', quote: 'ось так' }] }];

test('той самий вхід дає той самий ключ', () => {
  assert.equal(hash(a), hash(b));
});

test('змінився claim → ключ інший', () => {
  assert.notEqual(hash(a), hash([{ ...a[0], claim: 'інше' }]));
});

test('змінився тип → ключ інший', () => {
  assert.notEqual(hash(a), hash([{ ...a[0], type: 'strength' }]));
});

test('інший дзвінок у доказі → ключ інший', () => {
  assert.notEqual(hash(a), hash([{ ...a[0], evidence: [{ callId: '2', quote: 'ось так' }] }]));
});

test('додався finding → ключ інший', () => {
  assert.notEqual(hash(a), hash([...a, ...a]));
});

test('порожній вхід стабільний', () => {
  assert.equal(hash([]), hash([]));
});

test('ключ компактний і придатний для meta', () => {
  assert.ok(/^[0-9a-f]{16}$/.test(hash(a)));
});

test('кеш береться ЛИШЕ коли вхід не змінився', () => {
  assert.match(src, /stored\.meta\?\.inputHash === hash/);
});

test('зведення лежить окремим видом сегмента', () => {
  assert.match(src, /kind: GLOBAL_KIND/);
});

test('збій запису кешу не валить звіт', () => {
  assert.match(src, /upsertReportSegment\([\s\S]{0,400}\}\)\.catch\(/);
});

test('збій читання кешу теж не валить', () => {
  assert.match(src, /getStoredSegment\(name, from, to, GLOBAL_KIND\)\.catch\(\(\) => null\)/);
});

test('період округлено до доби — інакше ключ мінявся б щосекунди', () => {
  assert.match(src.match(/const dayStart[\s\S]*?const dayEnd[^\n]*/)[0], /Date\.UTC/);
});

test('порядок findings не впливає на ключ', () => {
  const f1 = { type: 'error', claim: 'A', evidence: [{ callId: '1', quote: 'x' }] };
  const f2 = { type: 'strength', claim: 'B', evidence: [{ callId: '2', quote: 'y' }] };
  assert.equal(hash([f1, f2]), hash([f2, f1]));
});

test('порядок доказів усередині finding теж не впливає', () => {
  const g1 = { type: 'error', claim: 'A', evidence: [{ callId: '1', quote: 'x' }, { callId: '2', quote: 'y' }] };
  const g2 = { type: 'error', claim: 'A', evidence: [{ callId: '2', quote: 'y' }, { callId: '1', quote: 'x' }] };
  assert.equal(hash([g1]), hash([g2]));
});

test('імʼя менеджера прибирається з тексту', () => {
  assert.equal(withoutName('Менеджер Роман постійно перебиває', 'Роман'), 'Менеджер постійно перебиває');
});

test('кома, що лишилась від імені, теж прибирається', () => {
  assert.equal(withoutName('Андрій, на жаль, не уточнює деталі', 'Андрій'), 'На жаль, не уточнює деталі');
});

test('імʼя всередині іншого слова не чіпається', () => {
  assert.equal(withoutName('Романтика в розмові', 'Роман'), 'Романтика в розмові');
});

test('якщо від тексту нічого не лишиться — лишаємо як є', () => {
  assert.equal(withoutName('Роман', 'Роман'), 'Роман');
});

test('порожнє імʼя нічого не ламає', () => {
  assert.equal(withoutName('Менеджер закриває угоди', ''), 'Менеджер закриває угоди');
});
