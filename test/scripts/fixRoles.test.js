import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, readSrc, sliceFunction } from '../helpers/repo.js';

const src = readSrc('scripts/fixRoles.js');
const repo = readSrc('features/analysis/repo.js');
const main = sliceFunction(src, 'async function main');

test('скрипт оголошений у package.json і веде на наявний файл', () => {
  const pkg = JSON.parse(readRepo('package.json'));
  assert.equal(pkg.scripts['fix:roles'], 'node src/scripts/fixRoles.js');
});

test('у роботу беруться лише дзвінки із записом І таймкодами', () => {
  const query = sliceFunction(repo, 'async function getCallsForRoleAudit');
  assert.match(query, /audio_path IS NOT NULL AND segments IS NOT NULL/);
  assert.match(query, /jsonb_array_length\(segments\) >= 2/);
});

test('моно-дзвінки не доходять до вердикту — на них замір дає монету', () => {
  assert.match(main, /if \(measured\.mono\) \{\s*\n\s*mono \+= 1;\s*\n\s*continue;/);
});

test('переписуються ЛИШЕ перевернуті, неоднозначні лишаються як є', () => {
  assert.match(main, /if \(verdict === ROLE_INVERTED\) \{/);
  const write = main.indexOf('applyRoleFix(');
  assert.ok(write > main.indexOf('if (verdict === ROLE_INVERTED)'), 'запис стався до вердикту');
});

test('transcript перезбирається з реплік цілком, а не патчиться регуляркою', () => {
  assert.match(main, /transcript: transcriptFromSegments\(segments\)/);
  assert.ok(!/replace\(/.test(main), 'підписи правляться по тексту — quoteMatch це зламає');
});

test('--dry-run не пише ні в calls, ні в кеш висновків', () => {
  assert.match(main, /if \(!DRY_RUN\) \{\s*\n\s*await applyRoleFix/);
  const guard = main.indexOf('if (DRY_RUN) {');
  assert.ok(guard > 0 && guard < main.indexOf('purgeReportCache('), 'сухий прогін дійде до чистки кешу');
});

test('виправленому дзвінку обнуляється все, що рахувалося з кривого тексту', () => {
  const fix = sliceFunction(repo, 'async function applyRoleFix');
  for (const column of [
    'behaviors', 'analysis_version', 'call_purpose', 'is_success', 'weakest_stage',
    'communication_score', 'deal_blocker', 'deal_blocker_quote', 'deal_blocker_reason',
    'client_decline_reason', 'intro_name', 'intro_company',
  ]) {
    assert.match(fix, new RegExp(`${column} = NULL`), `${column} лишиться порахованим з чужих реплік`);
  }
});

test('кеш висновків звіту чиститься для зачеплених менеджерів і дат', () => {
  const purge = sliceFunction(src, 'async function purgeReportCache');
  assert.match(purge, /deleteReportSegmentsOverlapping\(manager, span\.from, span\.to\)/);
  const sql = sliceFunction(readSrc('features/reporting/repo.js'), 'async function deleteReportSegmentsOverlapping');
  assert.match(sql, /DELETE FROM report_segments/);
  assert.match(sql, /kind = 'global' OR \(period_start < \$3 AND period_end > \$2\)/);
});

test('канал менеджера й запас читаються ззовні, а не вшиті у вердикт', () => {
  assert.match(main, /managerChannel: config\.call\.managerChannel/);
  assert.match(src, /const DEFAULT_MARGIN = 1\.35;/);
  assert.match(src, /flagValue\('--margin'\)/);
});

test('сміттєві оцінки на непродажних обнуляються тим самим прогоном', () => {
  const fn = sliceFunction(src, 'async function clearStaleScores');
  assert.match(fn, /countNonSalesScores\(\)/);
  assert.match(fn, /if \(DRY_RUN\)/, 'сухий прогін не має права писати');
  assert.match(fn, /clearNonSalesScores\(\)/);
  assert.ok(sliceFunction(src, 'async function main').indexOf('clearStaleScores()') > 0,
    'чистка не викликається з main');
});

test('чистка бере перелік непродажних категорій із таксономії, а не з власного списку', () => {
  const clear = sliceFunction(repo, 'async function clearNonSalesScores');
  assert.match(clear, /STALE_SCORES/);
  assert.match(repo, /const STALE_SCORES = `call_purpose = ANY\(\$1\)/);
  assert.match(repo, /import \{ NON_SALES_PURPOSES \}/);
  assert.ok(!/'info'/.test(clear) && !/'personal'/.test(clear), 'категорії продубльовані в репозиторії');
});

test('обнуляються саме оцінки, а не категорія — перекласифікація не скасовується', () => {
  const clear = sliceFunction(repo, 'async function clearNonSalesScores');
  assert.match(clear, /is_success = NULL, weakest_stage = NULL, communication_score = NULL/);
  assert.ok(!/call_purpose = NULL/.test(clear));
});
