import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, sliceFunction } from '../helpers/repo.js';

const headerSrc = sliceFunction(readSrc('bot/report.js'), 'function headerText(report) {');
const headerText = new Function('displayName', 'formatKyiv', `${headerSrc}; return headerText;`)(
  (n) => n,
  (d) => new Date(d).toISOString().slice(0, 10)
);

const base = { name: 'Роман', start: new Date('2026-09-19T10:00:00Z'), end: new Date('2026-09-19T16:30:00Z') };
const make = (stats) => headerText({ ...base, stats });

const noSales = make({ callCount: 2, salesCount: 0, successCount: 0, avgScore: null, topWeakStage: null });
const withSales = make({ callCount: 12, salesCount: 5, successCount: 3, reachableCount: 5, avgScore: 6.8, topWeakStage: 'закриття угоди' });
const blockedAll = make({ callCount: 4, salesCount: 2, successCount: 0, reachableCount: 0, avgScore: null, topWeakStage: null });
const noScore = make({ callCount: 9, salesCount: 3, successCount: 1, reachableCount: 3, avgScore: null, topWeakStage: null });

test('коли угод немає — жодного прочерку в тексті', () => {
  assert.ok(!noSales.includes('—\n') && !noSales.includes('*—*'));
});

test('кількість дзвінків і угод одним зрозумілим рядком', () => {
  assert.ok(noSales.includes('Дзвінків за період: *2*, з них угод: *0*.'));
});

test('прямо сказано, що угод не було', () => {
  assert.ok(noSales.includes('Жодної угоди за цей період не було'));
});

test('...і чому це означає відсутність оцінки', () => {
  assert.ok(noSales.includes('немає на чому'));
});

test('порожні бал і етап не друкуються взагалі', () => {
  assert.ok(!noSales.includes('Середній бал'));
});

test('«0 (0%)» більше не показується як показник', () => {
  assert.ok(!noSales.includes('Записів: *0* (0%)'));
});

test('звичайний період: дзвінки й угоди', () => {
  assert.ok(withSales.includes('Дзвінків за період: *12*, з них угод: *5*.'));
});

test('записи показані ВІД ЧОГО рахується відсоток', () => {
  assert.ok(withSales.includes('Записались: *3* з 5 (60%).'));
});

test('бал зі шкалою — інакше «6.8» ні про що не каже', () => {
  assert.ok(withSales.includes('Середній бал розмови: *6.8* з 10.'));
});

test('найслабший етап названо', () => {
  assert.ok(withSales.includes('Найслабший етап: *закриття угоди*.'));
});

test('усі угоди заблоковані — пояснення замість ділення на нуль', () => {
  assert.ok(blockedAll.includes('взяти не могло'));
});

test('...і жодної брехливої нульової конверсії', () => {
  assert.ok(!blockedAll.includes('(0%)'));
});

test('бал відсутній → сказано, що він ще не порахований', () => {
  assert.ok(noScore.includes('ще не порахований'));
});

test('етап відсутній → сказано прямо, а не прочерком', () => {
  assert.ok(noScore.includes('Найслабший етап: не визначився.'));
});

test('заголовок і формат розмітки збережені', () => {
  assert.ok(make({ callCount: 1, salesCount: 0, successCount: 0 }).includes('📊 *Доказовий звіт* — Роман'));
});
