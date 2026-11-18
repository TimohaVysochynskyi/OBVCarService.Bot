import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, readJson, sliceFunction } from '../../helpers/repo.js';
import { installFakeOpenAi, scripted, jsonResponse } from '../../helpers/fakeOpenAi.js';
import { detectClientComplaint } from '../../../src/features/analysis/clientComplaint.js';
import { COMPLAINT_KEYS, complaintLabel } from '../../../src/domain/call/complaint.js';

const analyze = readSrc('features/reporting/analyze.js');

const SEGMENTS = [
  { role: 'manager', text: 'Алло!', start: 0, end: 1 },
  { role: 'client', text: 'Ну я жду, чтоб ты мне вчера перезвонил, сегодня. Ну тебе не интересно работать?', start: 1, end: 7 },
  { role: 'manager', text: 'Я не на работе, я заболел.', start: 7, end: 10 },
];
const TRANSCRIPT = SEGMENTS.map((s) => `${s.role === 'manager' ? 'Менеджер' : 'Клієнт'}: ${s.text}`).join('\n\n');

async function run(reply, segments = SEGMENTS) {
  const fake = installFakeOpenAi(scripted([jsonResponse(reply)]));
  try {
    return await detectClientComplaint(TRANSCRIPT, segments);
  } finally {
    fake.restore();
  }
}

test('кейс Ігоря: претензія клієнта зараховується з його ж реплікою як цитатою', async () => {
  const found = await run({
    hasComplaint: true,
    type: 'no_callback',
    quote: 'Ну я жду, чтоб ты мне вчера перезвонил, сегодня',
  });
  assert.equal(found.hasComplaint, true);
  assert.equal(found.type, 'no_callback');
  assert.equal(found.start, 1);
});

test('цитата менеджера НЕ може стати претензією клієнта', async () => {
  const found = await run({ hasComplaint: true, type: 'no_callback', quote: 'Я не на работе, я заболел.' });
  assert.equal(found.hasComplaint, false);
  assert.equal(found.quote, null);
});

test('вигадана цитата відкидається повністю', async () => {
  const found = await run({ hasComplaint: true, type: 'quality', quote: 'ви зіпсували мені машину' });
  assert.equal(found.hasComplaint, false);
});

test('надто коротка цитата нічого не підтверджує', async () => {
  const found = await run({ hasComplaint: true, type: 'attitude', quote: 'Ну' });
  assert.equal(found.hasComplaint, false);
});

test('тип поза переліком не проходить', async () => {
  const found = await run({ hasComplaint: true, type: 'дуже злий', quote: 'Ну тебе не интересно работать?' });
  assert.equal(found.hasComplaint, false);
});

test('без сегментів цитата приймається на віру транскрипту, а не відкидається', async () => {
  const found = await run(
    { hasComplaint: true, type: 'no_callback', quote: 'Ну я жду, чтоб ты мне вчера перезвонил' },
    null
  );
  assert.equal(found.hasComplaint, true);
  assert.equal(found.start, null);
});

test('у кожного типу є підпис для людини', () => {
  for (const key of COMPLAINT_KEYS) assert.ok(complaintLabel(key), `немає підпису: ${key}`);
});

test('претензія стає кандидатом у звіт із роллю КЛІЄНТА', () => {
  const fn = sliceFunction(analyze, 'function complaintCandidates');
  assert.match(fn, /quoteRole: CLIENT_ROLE/);
  assert.match(fn, /type: 'error'/);
  assert.ok(sliceFunction(analyze, 'function buildCandidates').includes('complaintCandidates(c)'));
});

test('перевірка цитати бере роль із кандидата, а не завжди менеджера', () => {
  const fn = sliceFunction(analyze, 'function verifyCandidate');
  assert.match(fn, /const role = c\.quoteRole \|\| MANAGER_ROLE/);
  assert.match(fn, /findQuote\(c\.segments, c\.quote, \{ requireRole: role \}\)/);
  assert.ok(!/requireRole: 'manager'/.test(fn), 'роль знову прибита до менеджера');
});

test('решта типів доказів лишилась прибитою до реплік менеджера', () => {
  assert.match(readSrc('features/analysis/analyzeCall.js'), /requireRole: 'manager'/);
  assert.match(readSrc('features/analysis/dealBlocker.js'), /requireRole: 'manager'/);
  assert.match(readSrc('domain/call/intro.js'), /requireRole: 'manager'/);
});

test('у звіті видно, що це слова клієнта, а не менеджера', () => {
  assert.match(readSrc('features/reporting/report.js'), /ev\.said === 'client' \? 'КЛІЄНТ: ' : ''/);
  assert.match(readSrc('features/reporting/html/manager.js'), /e\.said === 'client'/);
});

test('промпт вимагає саме репліку клієнта і забороняє переказ', () => {
  const prompt = readJson('features/prompts/defaults.json').complaint.join('\n');
  assert.match(prompt, /ДОСЛІВНА фраза саме КЛІЄНТА/);
  assert.match(prompt, /Фраза менеджера не підходить/);
  assert.match(prompt, /Сумніваєшся — став false/);
});

test('претензія доходить до звіту навіть із НЕПРОДАЖНОГО дзвінка', () => {
  const fn = sliceFunction(analyze, 'function buildCandidates');
  assert.ok(fn.includes('? complaints'), 'непродажні дзвінки не дають жодного кандидата');
  assert.ok(!fn.includes('includes(c.callPurpose)) return;'),
    'непродажні знову відкидаються цілком — саме там і лежали всі скарги з реального кейсу');
});

test('із непродажних беруться ЛИШЕ претензії, а не весь розбір', () => {
  const fn = sliceFunction(analyze, 'function buildCandidates');
  const branch = fn.slice(fn.indexOf('? complaints'), fn.indexOf('];'));
  assert.ok(!branch.includes('behaviors'), 'поведінки менеджера почали рахуватись на непродажних');
});
