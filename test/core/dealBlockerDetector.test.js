import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeOpenAi, scripted, jsonResponse } from '../helpers/fakeOpenAi.js';
import { detectDealBlocker, NO_BLOCKER } from '../../src/core/dealBlocker.js';

const TRANSCRIPT = [
  'Клієнт: Добрий день, хочу записатись на сьогодні.',
  'Менеджер: Сьогодні все розписано, вільних місць немає.',
  'Клієнт: А завтра?',
  'Менеджер: Завтра теж зайнято, можу запропонувати четвер.',
  'Клієнт: Четвер мені не підходить, буду шукати інших.',
].join('\n');

const SEGMENTS = [
  { role: 'client', text: 'Добрий день, хочу записатись на сьогодні.', start: 0, end: 3 },
  { role: 'manager', text: 'Сьогодні все розписано, вільних місць немає.', start: 3, end: 7 },
  { role: 'client', text: 'А завтра?', start: 7, end: 8 },
  { role: 'manager', text: 'Завтра теж зайнято, можу запропонувати четвер.', start: 8, end: 12 },
  { role: 'client', text: 'Четвер мені не підходить, буду шукати інших.', start: 12, end: 16 },
];

const FOUND = {
  blocker: 'no_slot',
  reason: 'busy',
  quote: 'Сьогодні все розписано, вільних місць немає.',
};

async function run(replies) {
  const fake = installFakeOpenAi(scripted(replies));
  try {
    const result = await detectDealBlocker(TRANSCRIPT, SEGMENTS, 'Роман');
    return { result, calls: fake.calls };
  } finally {
    fake.restore();
  }
}

test('знайдений блокер із підтвердженням рецензента доходить до бази', async () => {
  const { result } = await run([
    jsonResponse(FOUND),
    jsonResponse({ confirmed: true, reason: 'менеджер прямо сказав, що місць немає' }),
  ]);
  assert.equal(result.blocker, 'no_slot');
  assert.equal(result.reason, 'busy');
  assert.equal(result.quote, FOUND.quote);
  assert.equal(result.start, 3);
  assert.equal(result.end, 7);
  assert.ok(!result.unchecked);
});

test('канонічний кейс: запропонував альтернативу, клієнт пішов — це ВСЕ ОДНО блокер', async () => {
  const { result } = await run([
    jsonResponse({ ...FOUND, quote: 'Завтра теж зайнято, можу запропонувати четвер.' }),
    jsonResponse({ confirmed: true, reason: 'альтернатива не прийнята' }),
  ]);
  assert.equal(result.blocker, 'no_slot');
});

test('рецензент відхилив — блокера немає, і це ПЕРЕВІРЕНИЙ факт', async () => {
  const { result } = await run([
    jsonResponse(FOUND),
    jsonResponse({ confirmed: false, reason: 'клієнта записали на іншу дату' }),
  ]);
  assert.equal(result.blocker, NO_BLOCKER);
  assert.ok(!result.unchecked, 'законне відкидання не має лишати рядок на перевірку');
});

test('ЗБІЙ рецензента ≠ «блокера немає»: рядок лишається unchecked', async () => {
  const { result } = await run([
    jsonResponse(FOUND),
    new Error('openai перевірка незакритої угоди: HTTP 500'),
  ]);
  assert.equal(result.blocker, NO_BLOCKER);
  assert.equal(result.unchecked, true);
});

test('цитати немає в сегментах менеджера — блокер відкидається КОДОМ, без рецензента', async () => {
  const { result, calls } = await run([
    jsonResponse({ ...FOUND, quote: 'Такого рядка в розмові не було взагалі' }),
  ]);
  assert.equal(result.blocker, NO_BLOCKER);
  assert.ok(!result.unchecked);
  assert.equal(calls.length, 1, 'рецензента не мали кликати');
});

test('цитата КЛІЄНТА не може підперти блокер', async () => {
  const { result, calls } = await run([
    jsonResponse({ ...FOUND, quote: 'Четвер мені не підходить, буду шукати інших.' }),
  ]);
  assert.equal(result.blocker, NO_BLOCKER);
  assert.equal(calls.length, 1);
});

test('роль перед цитатою не заважає знайти репліку', async () => {
  const { result } = await run([
    jsonResponse({ ...FOUND, quote: 'Менеджер: Сьогодні все розписано, вільних місць немає.' }),
    jsonResponse({ confirmed: true, reason: 'ok' }),
  ]);
  assert.equal(result.blocker, 'no_slot');
});

test('причина з ЧУЖОГО бакета відкидається, а сам блокер лишається', async () => {
  const { result } = await run([
    jsonResponse({ ...FOUND, reason: 'no_part' }),
    jsonResponse({ confirmed: true, reason: 'ok' }),
  ]);
  assert.equal(result.blocker, 'no_slot');
  assert.equal(result.reason, null);
});

test('вигаданий бакет не проходить enum', async () => {
  const { result, calls } = await run([jsonResponse({ blocker: 'немає_настрою', reason: '', quote: '' })]);
  assert.equal(result.blocker, NO_BLOCKER);
  assert.equal(calls.length, 1);
});

test('модель сказала «блокера немає» — жодного другого виклику', async () => {
  const { result, calls } = await run([jsonResponse({ blocker: 'none', reason: '', quote: '' })]);
  assert.equal(result.blocker, NO_BLOCKER);
  assert.equal(calls.length, 1);
});

test('обидва виклики йдуть із temperature 0 — це часовий ряд', async () => {
  const { calls } = await run([
    jsonResponse(FOUND),
    jsonResponse({ confirmed: true, reason: 'ok' }),
  ]);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.body.temperature, 0, `${call.op} пішов не на нулі`);
});

test('обидва виклики йдуть найсильнішою моделлю і зі схемою', async () => {
  const { calls } = await run([
    jsonResponse(FOUND),
    jsonResponse({ confirmed: true, reason: 'ok' }),
  ]);
  for (const call of calls) {
    assert.equal(call.body.model, 'gpt-4o');
    assert.equal(call.body.response_format.type, 'json_schema');
    assert.equal(call.body.response_format.json_schema.strict, true);
  }
});

test('порожній транскрипт не коштує жодного запиту', async () => {
  const fake = installFakeOpenAi(() => { throw new Error('не мало бути викликів'); });
  try {
    const result = await detectDealBlocker('', [], 'Роман');
    assert.equal(result.blocker, NO_BLOCKER);
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

test('жоден із цих тестів не ходив у мережу', async () => {
  const { calls } = await run([
    jsonResponse(FOUND),
    jsonResponse({ confirmed: true, reason: 'ok' }),
  ]);
  for (const call of calls) assert.ok(call.path.startsWith('/'), 'транспорт підмінено, реального URL немає');
});
