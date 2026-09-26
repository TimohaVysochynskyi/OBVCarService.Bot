import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../helpers/repo.js';

const errSrc = readSrc('core/errors.js');
const retrySrc = readSrc('core/retry.js');

const retryAfterMs = new Function(
  `${errSrc.match(/const MAX_RETRY_AFTER_MS[\s\S]*?function retryAfterMs\(res, body\)\s*\{[\s\S]*?\n\}/)[0]}; return retryAfterMs;`
)();
const res = (h) => ({ headers: { get: (k) => h[k.toLowerCase()] ?? null } });
const none = res({});

const REAL_BODY = JSON.stringify({
  error: {
    message: 'Rate limit reached for gpt-4o in organization org-X on tokens per min (TPM): Limit 30000, Used 29326, Requested 1521. Please try again in 1.694s. Visit https://platform.openai.com/account/rate-limits to learn more.',
    type: 'tokens',
    code: 'rate_limit_exceeded',
  },
});

test('підказку з РЕАЛЬНОГО тіла 429 прочитано (1.694s → 1694 мс)', () => {
  assert.equal(retryAfterMs(none, REAL_BODY), 1694);
});

test('заголовок retry-after у секундах', () => {
  assert.equal(retryAfterMs(res({ 'retry-after': '3' }), ''), 3000);
});

test('заголовок у мілісекундах', () => {
  assert.equal(retryAfterMs(res({ 'retry-after': '500ms' }), ''), 500);
});

test('заголовок має пріоритет над текстом', () => {
  assert.equal(retryAfterMs(res({ 'retry-after': '2' }), REAL_BODY), 2000);
});

test('без підказки — null, а не 0', () => {
  assert.equal(retryAfterMs(none, 'щось зовсім інше'), null);
});

test('порожнє тіло не ламає розбір', () => {
  assert.equal(retryAfterMs(none, ''), null);
});

test('абсурдне значення обрізається до 60с', () => {
  assert.equal(retryAfterMs(res({ 'retry-after': '99999' }), ''), 60000);
});

test('відʼємне значення ігнорується', () => {
  assert.equal(retryAfterMs(res({ 'retry-after': '-5' }), ''), null);
});

test('сміття в заголовку ігнорується', () => {
  assert.equal(retryAfterMs(res({ 'retry-after': 'дурня' }), ''), null);
});

test('розбір працює й без обʼєкта відповіді', () => {
  assert.equal(retryAfterMs(null, 'try again in 250ms'), 250);
});

test('httpError чіпляє підказку до помилки', () => {
  assert.match(errSrc, /const hinted = retryAfterMs\(res, body\);\s*\n\s*if \(hinted != null\) err\.retryAfterMs = hinted;/);
});

test('чекаємо НЕ МЕНШЕ, ніж просить сервіс', () => {
  assert.match(retrySrc, /Math\.max\(base, hinted \+ 300\)/);
});

test('є розкид, щоб паралельні запити не били в ту саму мілісекунду', () => {
  assert.match(retrySrc, /Math\.random\(\)/);
});

const buildRetry = () => {
  const waited = [];
  const fakeSleep = (fn, ms) => { waited.push(ms); fn(); };
  const src = `${retrySrc.replace('export async function withRetry', 'async function withRetry')}\nreturn withRetry;`;
  return { waited, run: new Function('setTimeout', 'console', src)(fakeSleep, { error() {} }) };
};

const hinted = buildRetry();
let hintedCalls = 0;
await assert.rejects(() => hinted.run(async () => {
  hintedCalls += 1;
  const e = new Error('429');
  e.retryAfterMs = 5000;
  throw e;
}, { attempts: 3, delayMs: 1000 }));

const plain = buildRetry();
let plainCalls = 0;
await assert.rejects(() => plain.run(async () => {
  plainCalls += 1;
  throw new Error('звичайна');
}, { attempts: 3, delayMs: 1000 }));

test('усі спроби використані', () => {
  assert.equal(hintedCalls, 3);
  assert.equal(plainCalls, 3);
});

test('кожна пауза не менша за підказані 5с (+запас)', () => {
  assert.ok(hinted.waited.every((w) => w >= 5300), `чекали менше за підказку: ${hinted.waited.join(',')}`);
});

test('без підказки — стара наростаюча пауза', () => {
  assert.ok(plain.waited[0] >= 1000 && plain.waited[0] < 1300);
});

test('пауза росте з номером спроби', () => {
  assert.ok(plain.waited[1] >= 2000 && plain.waited[1] < 2300);
});

test('reduce звіту має 4 спроби замість 2', () => {
  assert.match(readSrc('bot/analyze.js'), /attempts: 4, delayMs: 3000, label: `OpenAI reduce/);
});

test('збій аналізу → беремо вже пораховане, звіт не гине', () => {
  assert.match(readSrc('bot/globalReportData.js'), /catch \(err\)[\s\S]{0,300}collectRangeFindings\(name, start, end, \{ analyze: false \}\)/);
});

test('збій зведення теж не фатальний', () => {
  assert.match(readSrc('bot/globalReportData.js'), /mergeFindings\(name, errors\)\.catch\(\(\) => \[\]\)/);
});

test('плюси й мінуси зводяться послідовно, не бʼють ліміт удвох', () => {
  assert.ok(!/Promise\.all\(\[\s*errors\.length/.test(readSrc('bot/globalReportData.js')));
});

test('неповний аналіз стає ВИДИМИМ у документі', () => {
  assert.match(readSrc('bot/globalReportHtml.js'), /if \(!manager\.partial \|\| !manager\.days\) return '';/);
});
