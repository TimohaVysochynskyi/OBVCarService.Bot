import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../helpers/repo.js';

const src = readSrc('core/errorTexts.js');
const texts = [...src.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)]
  .map((m) => m[1] ?? m[2])
  .filter((s) => /[а-яіїєґА-ЯІЇЄҐ]/.test(s));

const FORBIDDEN = ['на жаль', 'ой,', 'щось пішло не так', 'вибачте', 'перепрошуємо'];

test('тексти помилок справді зібрані з файлу', () => {
  assert.ok(texts.length > 50, `знайдено лише ${texts.length} рядків — перевірка втратила предмет`);
});

test('жодного заборонених зворотів у текстах помилок', () => {
  const bad = texts.filter((t) => FORBIDDEN.some((f) => t.toLowerCase().includes(f)));
  assert.deepEqual(bad, [], `заборонені звороти: ${bad.join(' | ')}`);
});

test('жодного знака оклику', () => {
  const bad = texts.filter((t) => t.includes('!'));
  assert.deepEqual(bad, [], `знак оклику в тексті помилки: ${bad.join(' | ')}`);
});

test('емодзі в середині речення немає', () => {
  const bad = texts.filter((t) => /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(t.slice(1).trim()));
  assert.deepEqual(bad, [], `емодзі всередині тексту: ${bad.join(' | ')}`);
});

test('у кожного коду заповнені всі три слоти: причина, що робити, доля даних', () => {
  const body = src.slice(src.indexOf('const CODES'));
  const entries = [...body.matchAll(/'([A-Z][A-Z0-9-]*)':\s*\{([\s\S]*?)\n {2}\},/g)];
  assert.ok(entries.length >= 40, `розібрано лише ${entries.length} кодів`);
  const incomplete = entries
    .filter((m) => !/cause:/.test(m[2]) || !/action:/.test(m[2]) || !/data:/.test(m[2]))
    .map((m) => m[1]);
  assert.deepEqual(incomplete, [], `неповний опис помилки: ${incomplete.join(', ')}`);
});

test('дію в кожному коді написано з малої літери', () => {
  const actions = [...src.matchAll(/action: ['`]([^'`]+)['`]/g)].map((m) => m[1]);
  assert.ok(actions.length >= 40);
  const capitalised = actions.filter((a) => /^[А-ЯІЇЄҐ]/.test(a));
  assert.deepEqual(capitalised, [], `дія з великої літери: ${capitalised.join(' | ')}`);
});

test('слово «продажний» не трапляється у видимих текстах', () => {
  for (const file of ['core/errorTexts.js', 'bot/report.js', 'bot/globalReportHtml.js', 'bot/archive.js', 'bot/dynamics.js']) {
    assert.ok(!/продажн/.test(readSrc(file)), `${file}: у видимому тексті вжито «продажний»`);
  }
});
