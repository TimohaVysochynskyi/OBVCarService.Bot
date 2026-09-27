import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SRC, readSrc, orphanClasses } from '../../helpers/repo.js';
import { report } from './fixture.js';
import { categoryTable } from '../../../src/features/reporting/html/categories.js';
import { linesSection } from '../../../src/features/reporting/html/lines.js';
import { introSection } from '../../../src/features/reporting/html/intro.js';
import { managerCard } from '../../../src/features/reporting/html/manager.js';
import { compareSection } from '../../../src/features/reporting/html/compare.js';
import { declineSection } from '../../../src/features/reporting/html/declines.js';
import { stagesSection } from '../../../src/features/reporting/html/stages.js';
import { methodSection } from '../../../src/features/reporting/html/method.js';
import { esc } from '../../../src/features/reporting/html/format.js';

const HTML_DIR = path.join(SRC, 'features/reporting/html');
const css = readSrc('features/reporting/site/app.css');
const appJs = readSrc('features/reporting/site/app.js');

const SECTIONS = {
  'категорії': () => categoryTable(report.totals.purposes, report.directions, report.totals.calls),
  'номери': () => linesSection(report),
  'представлення': () => introSection(report),
  'картка менеджера': () => managerCard(report.managers[0], report.months),
  'порівняння': () => compareSection(report),
  'відмови': () => declineSection(report.declines),
  'етапи': () => stagesSection(report.stages),
  'як це рахується': () => methodSection(report),
};

test('кожна секція — окремий модуль, і жоден не розрісся', () => {
  const files = fs.readdirSync(HTML_DIR).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(files, ['categories.js', 'compare.js', 'declines.js', 'format.js', 'intro.js',
    'lines.js', 'manager.js', 'method.js', 'page.js', 'stages.js', 'tokens.js', 'widgets.js']);
  for (const file of files) {
    const lines = fs.readFileSync(path.join(HTML_DIR, file), 'utf8').split('\n').length;
    assert.ok(lines < 200, `${file} розрісся до ${lines} рядків`);
  }
});

test('кожна секція рендериться окремо і віддає непорожній рядок', () => {
  for (const [name, render] of Object.entries(SECTIONS)) {
    const html = render();
    assert.equal(typeof html, 'string', `${name} віддала не рядок`);
    assert.ok(html.length > 50, `${name} віддала порожнечу`);
  }
});

test('у жодній секції немає undefined, NaN чи [object Object]', () => {
  for (const [name, render] of Object.entries(SECTIONS)) {
    const html = render();
    for (const bad of ['undefined', 'NaN', '[object Object]']) {
      assert.ok(!html.includes(bad), `${name}: протік ${bad}`);
    }
  }
});

test('кожен клас кожної секції має правило в зібраному CSS', () => {
  for (const [name, render] of Object.entries(SECTIONS)) {
    const { orphans } = orphanClasses(render(), css, appJs);
    assert.deepEqual(orphans, [], `${name}: класи без правила — ${orphans.join(', ')}`);
  }
});

test('усе, що йде в HTML, екранується: лапки клієнта не ламають розмітку', () => {
  assert.equal(esc('Олег "Петрович" & <b>'), 'Олег &quot;Петрович&quot; &amp; &lt;b&gt;');
  const declines = declineSection(report.declines);
  assert.ok(declines.includes('Олег &quot;Петрович&quot;'), 'імʼя клієнта пішло в HTML сирим');
  assert.ok(!declines.includes('Олег "Петрович"'));
});

test('цитата з розміткою екранується в картці менеджера', () => {
  const card = managerCard(report.managers[0], report.months);
  assert.ok(card.includes('&lt;b&gt;Опишіть&lt;/b&gt;'));
  assert.ok(!card.includes('<b>Опишіть</b>'));
});

test('секції не знають одна про одну — лише про токени, формат і віджети', () => {
  const SHARED = ['./format.js', './tokens.js', './widgets.js'];
  const sections = ['categories.js', 'lines.js', 'intro.js', 'manager.js', 'compare.js',
    'declines.js', 'stages.js', 'method.js'];
  for (const file of sections) {
    const src = fs.readFileSync(path.join(HTML_DIR, file), 'utf8');
    const local = [...src.matchAll(/from '(\.\/[^']+)'/g)].map((m) => m[1]);
    const foreign = local.filter((d) => !SHARED.includes(d));
    assert.deepEqual(foreign, [], `${file} тягне сусідню секцію: ${foreign.join(', ')}`);
  }
});

test('сторінку збирає page.js, і саме він кличе кожну секцію', () => {
  const page = fs.readFileSync(path.join(HTML_DIR, 'page.js'), 'utf8');
  for (const call of ['categoryTable(', 'linesSection(', 'introSection(', 'managerCard(',
    'compareSection(', 'declineSection(', 'stagesSection(', 'methodSection(']) {
    assert.ok(page.includes(call), `page.js не кличе ${call}`);
  }
  assert.ok(page.includes('<!doctype html>'));
});

test('точка входу лишилась тією самою, тож усі споживачі не помітили переїзду', () => {
  assert.equal(readSrc('features/reporting/globalReportHtml.js').trim(),
    "export { renderGlobalReport } from './html/page.js';");
});

test('картка менеджера без знахідок не падає і не бреше', () => {
  const card = managerCard(report.managers[2], report.months);
  assert.ok(card.includes('data-manager-card="Володимир"'));
  assert.ok(!card.includes('undefined'));
});

test('секція порівняння зникає, коли порівнювати нема з ким', () => {
  const solo = { ...report, managers: [report.managers[0]], totals: { ...report.totals, managers: 1 } };
  assert.equal(compareSection(solo), '');
});

test('секції без даних не лишають порожньої рамки', () => {
  assert.equal(stagesSection([]), '');
  assert.equal(introSection({ ...report, intro: null }), '');
  assert.equal(linesSection({ ...report, lines: [] }), '');
});
