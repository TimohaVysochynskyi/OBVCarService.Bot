import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../../helpers/repo.js';
import { config } from '../../../src/shared/config.js';

const seg = readSrc('features/reporting/segments.js');
const fn = seg.match(/async function collectRangeFindings\([\s\S]*?\n\}/)[0];
const day = seg.match(/async function getOrComputeDaySegment[\s\S]*?\n\}/)[0];
const after = day.slice(day.indexOf('analyzeSegment'));
const data = readSrc('features/reporting/globalReportData.js');

test('темп і дедлайн вимкнені за замовчуванням', () => {
  assert.match(fn, /pauseMs = 0, deadline = null/);
});

test('день, що впав, не валить увесь період', () => {
  assert.match(fn, /catch \(err\) \{\s*\n\s*failedDays \+= 1;/);
});

test('...а просто випадає з добірки', () => {
  assert.match(fn, /return null;\s*\n\s*\}\s*\n\s*\}\);/);
});

test('після дедлайну нові дні не аналізуються', () => {
  assert.match(fn, /deadline != null && Date\.now\(\) > deadline/);
});

test('вичерпаний бюджет фіксується', () => {
  assert.match(fn, /if \(expired\) ranOutOfTime = true/);
});

test('після дедлайну беремо лише те, що в кеші', () => {
  assert.match(fn, /analyze: !expired/);
});

test('обидва сигнали повертаються назовні', () => {
  assert.match(fn, /failedDays,\s*\n\s*ranOutOfTime,/);
});

test('є колбек «день справді рахувався»', () => {
  assert.match(day, /onComputed = null/);
});

test('витримка робиться ПІСЛЯ аналізу', () => {
  assert.match(after, /if \(onComputed\) await onComputed\(\)/);
});

test('день без дзвінків не чекає дарма', () => {
  assert.ok(after.indexOf('if (!seg) return null;') < after.indexOf('onComputed'));
});

test('на кешованому дні витримки немає', () => {
  const before = day.slice(day.indexOf(String.fromCharCode(10)), day.indexOf('if (!analyze) return null;'));
  assert.ok(!/onComputed/.test(before));
});

test('звіт іде по одному дню за раз', () => {
  assert.match(data, /REPORT_CONCURRENCY = config\.report\.concurrency/);
  assert.equal(config.report.concurrency, 1);
});

test('між днями півтори секунди', () => {
  assert.match(data, /REPORT_PAUSE_MS = config\.report\.pauseMs/);
  assert.equal(config.report.pauseMs, 1500);
});

test('бюджет команди — дві хвилини', () => {
  assert.match(data, /REPORT_BUDGET_MS = config\.report\.budgetMs/);
  assert.equal(config.report.budgetMs, 120000);
});

test('бюджет 0 = без обмеження', () => {
  assert.match(data, /const deadline = budgetMs > 0 \? Date\.now\(\) \+ budgetMs : null;/);
});

test('неповне покриття позначається навіть БЕЗ винятку', () => {
  assert.match(data, /partial: Boolean\(collected\?\.failedDays \|\| collected\?\.ranOutOfTime\)/);
});

test('прогрів не обмежений часом', () => {
  assert.match(readSrc('scripts/warmGlobalReport.js'), /buildGlobalReport\(\{ analyze, budgetMs: 0 \}\)/);
});

test('неповний прогрів дає non-zero, тож його можна ганяти в циклі', () => {
  assert.match(readSrc('scripts/warmGlobalReport.js'), /process\.exitCode = 1/);
});

test('плашка в документі йде саме за прапорцем partial', () => {
  assert.match(readSrc('features/reporting/globalReportHtml.js'), /if \(!manager\.partial \|\| !manager\.days\) return '';/);
});
