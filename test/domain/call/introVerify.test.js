import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, readJson } from '../../helpers/repo.js';
import { verifyIntro } from '../../../src/domain/call/intro.js';

const segs = [
  { role: 'manager', text: 'Алло!' },
  { role: 'client', text: 'Це Роман? Доброго дня, ОБВ Кар Сервіс?' },
  { role: 'manager', text: 'Одигикар Сервис, Роман слухає' },
  { role: 'manager', text: 'Да, зараз подивлюсь' },
];
const v = (raw) => verifyIntro(raw, segs, 'Роман');

test('модель сказала «ні» — так і лишається', () => {
  assert.deepEqual(v({ name: false, nameQuote: '', company: false, companyQuote: '' }), { name: false, company: false });
});

test('«Алло!» як доказ імені не проходить', () => {
  assert.equal(v({ name: true, nameQuote: 'Алло!', company: false, companyQuote: '' }).name, false);
});

test('репліка КЛІЄНТА не зараховується менеджеру, хоч імʼя в ній є', () => {
  assert.equal(v({ name: true, nameQuote: 'Це Роман? Доброго дня', company: false, companyQuote: '' }).name, false);
});

test('вигадана цитата, якої в розмові немає, відкидається', () => {
  assert.equal(v({ name: true, nameQuote: 'Роман вас турбує', company: false, companyQuote: '' }).name, false);
});

test('справжня репліка менеджера з іменем — зараховується', () => {
  assert.equal(v({ name: true, nameQuote: 'Одигикар Сервис, Роман слухає', company: false, companyQuote: '' }).name, true);
});

test('спотворена назва НАШОГО сервісу проходить', () => {
  assert.equal(v({ name: false, nameQuote: '', company: true, companyQuote: 'Одигикар Сервис, Роман слухає' }).company, true);
});

test('ЧУЖІ компанії не зараховуються', () => {
  for (const other of ['Вас вітає БМВ Сервіс. Будь ласка, залишайтеся на лінії.',
    'Алло, доброго дня! ВБ автосервіс.',
    'Алло, доброго дня, брокер сервіс.']) {
    const segsOther = [{ role: 'manager', text: other }];
    assert.equal(
      verifyIntro({ name: false, nameQuote: '', company: true, companyQuote: other }, segsOther, 'Роман').company,
      false,
      `пройшло чуже: ${other}`
    );
  }
});

test('репліка без назви сервісу не зараховується за сервіс', () => {
  assert.equal(v({ name: false, nameQuote: '', company: true, companyQuote: 'Да, зараз подивлюсь' }).company, false);
});

test('відсутня або неповна відповідь моделі = «не представився», без падіння', () => {
  assert.deepEqual(v(undefined), { name: false, company: false });
  assert.deepEqual(v({ name: true }), { name: false, company: false });
});

test('інжест не вірить булеві моделі на слово', () => {
  const analyzeJs = readSrc('features/analysis/analyzeCall.js');
  assert.ok(analyzeJs.includes('verifyIntro(raw.intro, verifySegments, managerName)'));
  assert.ok(!analyzeJs.includes('raw.intro?.name === true'));
});

test('промпт прямо каже, що імʼя в шапці — не доказ', () => {
  const intro = readJson('features/prompts/defaults.json').intro.join('\n');
  assert.ok(/СЛУЖБОВА примітка/.test(intro) && /nameQuote/.test(intro));
});
