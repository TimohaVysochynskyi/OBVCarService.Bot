import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, sliceFunction, orphanClasses } from '../helpers/repo.js';
import { renderGlobalReport } from '../../src/bot/globalReportHtml.js';
import { buildIntro } from '../../src/bot/globalReportData.js';
import { detectIntro, nameStems } from '../../src/core/managerIntro.js';

const css = readSrc('bot/site/app.css');
const appJs = readSrc('bot/site/app.js');
const storeJs = readSrc('core/store.js');
const reportJs = readSrc('bot/report.js');
const analyzeJs = readSrc('core/analyzeCall.js');
const backfillJs = readSrc('scripts/backfillIntro.js');

const seg = (...ts) => ts.map((t) => ({ role: 'manager', text: t }));
const d = (segs, name) => detectIntro({ segments: segs, transcript: null, managerName: name });

test('«Алло!» — це не представлення', () => {
  assert.deepEqual(d(seg('Алло!'), 'Роман'), { name: false, company: false });
});

test('назвав своє імʼя на вихідному дзвінку', () => {
  assert.deepEqual(d(seg('Алло! Добрый день, Елена. Роман по поводу Audi.'), 'Роман'), { name: true, company: false });
});

test('усі 10 РЕАЛЬНИХ спотворень назви сервісу впізнані', () => {
  for (const real of ['АБВ Кар Сервіс', 'АВВ Кар Сервіс', 'ВіВі Кар Сервіс', 'Авивикар Сервис',
    'Адікар Сервіс', 'Аудіовікар Сервіс', 'ОДВ Карсервис', 'Одигикар Сервис',
    'ЛБВ Карсервіс', 'ОБЗ, карсервіс']) {
    assert.equal(d(seg(`${real}, слухаю`), 'Андрій').company, true, `не впізнав: ${real}`);
  }
});

test('назва через ДЕФІС теж упізнається', () => {
  for (const real of ['Объяви кар-сервис', 'АБВ кар-сервис', 'кар-сервіс']) {
    assert.equal(d(seg(`${real}. Добрий день!`), 'Андрій').company, true, `не впізнав через дефіс: ${real}`);
  }
});

test('латинське й літерне написання теж', () => {
  assert.equal(d(seg('OBV Car Service'), 'Андрій').company, true);
  assert.equal(d(seg('Це О Бі Ві, вітаю'), 'Андрій').company, true);
});

test('розмовні форми імені (Вова / Андрей / Володя) рахуються', () => {
  assert.equal(d(seg('Вова на звʼязку'), 'Володимир').name, true);
  assert.equal(d(seg('Андрей, слушаю'), 'Андрій').name, true);
  assert.equal(d(seg('Володі передзвоніть'), 'Володимир').name, true);
});

test('змішана латиниця в імені не ламає збіг', () => {
  assert.equal(d(seg('Poмaн слухає'), 'Роман').name, true);
});

test('стем шукається лише з початку слова', () => {
  assert.equal(d(seg('Це громадський транспорт'), 'Роман').name, false);
});

test('назва в пʼятій репліці — вже не представлення', () => {
  assert.equal(d(seg('Алло', 'Так', 'Угу', 'Добре', 'Ми АБВ Кар Сервіс'), 'Роман').company, false);
});

test('репліка КЛІЄНТА не зараховується менеджеру', () => {
  assert.deepEqual(d([{ role: 'client', text: 'Це Роман, АБВ Кар Сервіс' }], 'Роман'), { name: false, company: false });
});

test('без діаризації читається транскрипт із мітками «Менеджер:»', () => {
  assert.deepEqual(
    detectIntro({ segments: null, transcript: 'Менеджер: Це Роман\nКлієнт: Добрий день', managerName: 'Роман' }),
    { name: true, company: false }
  );
});

test('порожній дзвінок і закоротке імʼя не падають', () => {
  assert.deepEqual(d([], 'Роман'), { name: false, company: false });
  assert.deepEqual(d(seg('Алло'), 'Ян'), { name: false, company: false });
});

test('стеми: закоротке імʼя відкидається, звичайне дає корінь', () => {
  assert.ok(!nameStems('Ян').length && nameStems('Роман').includes('рома'));
});

const monthKeys = ['2026-06', '2026-07'];
const months = [{ key: '2026-06', title: 'червень 2026' }, { key: '2026-07', title: 'липень 2026' }];
const row = (manager, month, o) => ({
  manager, month, checked: 0, checkedIn: 0, checkedOut: 0,
  withName: 0, withCompany: 0, withBoth: 0, withNameIn: 0, withNameOut: 0, ...o,
});
const intro = buildIntro([
  row('Роман', '2026-06', { checked: 100, checkedIn: 60, checkedOut: 40, withName: 8, withCompany: 2, withBoth: 2, withNameIn: 6, withNameOut: 2 }),
  row('Роман', '2026-07', { checked: 50, checkedIn: 30, checkedOut: 20, withName: 2, withCompany: 0 }),
  row('Андрій', '2026-06', { checked: 10, checkedIn: 4, checkedOut: 6, withName: 1, withCompany: 1, withBoth: 1 }),
], monthKeys);

test('менеджери впорядковані за кількістю перевірених дзвінків', () => {
  assert.deepEqual(intro.managers.map((m) => m.name), ['Роман', 'Андрій']);
});

test('«весь період» — сума місяців', () => {
  assert.equal(intro.managers[0].byMonth.all.checked, 150);
  assert.equal(intro.managers[0].byMonth.all.withName, 10);
});

test('місяць без даних присутній нулем, а не відсутній', () => {
  assert.equal(intro.managers[1].byMonth['2026-07'].checked, 0);
});

test('загальний підсумок по всіх менеджерах', () => {
  assert.equal(intro.total.checked, 160);
});

const base = {
  generatedAt: '2026-09-23T10:00:00.000Z',
  period: { start: '2026-06-19T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z' },
  totals: { calls: 160, seconds: 14200, hours: 3.9, managers: 2, purposes: { sales: 20, info: 60, other: 78, personal: 2 } },
  months,
  lines: [],
  directions: {},
  managers: [{ name: 'Роман', display: 'Роман', byMonth: { all: { calls: 10 } }, strengths: [], weaknesses: [], analysedDays: 1, days: 1, partial: false }],
  stages: [],
  declines: { buckets: {}, bucketTitles: {}, serviceTotal: 0, cases: [], reasons: [], coverage: { notBooked: 0 } },
};
const html = renderGlobalReport({ ...base, intro });
const section = html.slice(html.indexOf('>Представлення<'), html.indexOf('data-manager-tab'));

test('секція «Представлення» є в документі', () => {
  assert.ok(html.includes('>Представлення<'));
});

test('картка на кожного менеджера, у тому ж порядку', () => {
  const cards = [...html.matchAll(/data-intro-card="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cards, ['Роман', 'Андрій']);
});

test('дві смужки в картці: імʼя і сервіс', () => {
  assert.ok(html.includes('data-intro-bar="name"') && html.includes('data-intro-bar="company"'));
  assert.ok(html.includes('data-intro-pct="name"') && html.includes('data-intro-pct="company"'));
});

test('перемикач місяців: «Весь період» останній і обраний', () => {
  assert.ok(/data-intro-tab="2026-06"[\s\S]*?data-intro-tab="all" aria-selected="true"/.test(html));
});

test('числа в розмітці ПОРОЖНІ — їх ставить app.js', () => {
  assert.ok(!/data-intro-pct="[a-z]+"><\/span>\s*\d/.test(section));
  assert.ok(/data-intro-pct="name"><\/span>/.test(section));
});

test('пояснено, чому рахуються лише персональні номери', () => {
  assert.ok(/персональних номерах/.test(section) && /«None»/.test(section));
});

test('немає даних — немає й секції', () => {
  assert.ok(!renderGlobalReport({ ...base, intro: buildIntro([], monthKeys) }).includes('>Представлення<'));
  assert.ok(!renderGlobalReport(base).includes('>Представлення<'));
});

test('числа секції їдуть у JSON-блоці сторінки', () => {
  const payload = JSON.parse(/id="report-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(payload.intro['Роман'].all.checked, 150);
});

test('усі класи секції мають правило в зібраному CSS', () => {
  const { orphans } = orphanClasses(section, css);
  assert.deepEqual(orphans, [], `класи без правила в CSS: ${orphans.join(' ')}`);
});

test('initIntro існує і викликається на старті', () => {
  assert.ok(/function initIntro\(\)/.test(appJs) && /\n {4}initIntro\(\);/.test(appJs));
});

test('ширина смужки — частка від ПЕРЕВІРЕНИХ дзвінків, не від усіх', () => {
  assert.ok(appJs.includes("bar.style.width = ratio(value, checked) + '%'"));
});

test('місяць без дзвінків підписаний словами, а не нулями', () => {
  assert.ok(appJs.includes("'за цей місяць дзвінків не було'"));
});

test('обидва запити представлення обмежені персональними номерами', () => {
  assert.ok(/internal_number = ANY\(\$1\)/.test(storeJs) && /internal_number = ANY\(\$4\)/.test(storeJs));
});

test('список номерів береться з тієї ж мапи, якою інжест атрибутує дзвінки', () => {
  assert.ok(storeJs.includes('const PERSONAL_EXTENSIONS = Object.keys(PERSONAL_OPERATORS);'));
});

test('беклог відбирає саме NULL — перевірені рядки не переглядаються повторно', () => {
  assert.ok(/intro_name IS NULL/.test(storeJs));
});

const headerSrc = sliceFunction(reportJs, 'function headerText(report) {');
const headerText = new Function('displayName', 'formatKyiv', `${headerSrc}\nreturn headerText;`)(
  (x) => x,
  () => '01.01.2026 00:00'
);
const stats = (o = {}) => ({ callCount: 0, salesCount: 0, successCount: 0, reachableCount: 0, introChecked: 0, introNoName: 0, introNoCompany: 0, ...o });

test('нуль дзвінків: звіт будується і каже саме про це', () => {
  const zero = headerText({ name: 'Андрій', stats: stats(), start: new Date(), end: new Date() });
  assert.ok(zero.includes('Дзвінків за період: *0*'));
  assert.ok(zero.includes('Жодного дзвінка за цей період не було'));
  assert.ok(!zero.includes('усі розмови інформаційні'));
});

test('блок «Не представився» друкується з розбивкою', () => {
  const withIntro = headerText({
    name: 'Роман',
    stats: stats({ callCount: 40, salesCount: 10, successCount: 4, reachableCount: 10, introChecked: 40, introNoName: 37, introNoCompany: 39 }),
    start: new Date(),
    end: new Date(),
  });
  assert.ok(withIntro.includes('Не представився'));
  assert.ok(withIntro.includes('не назвав своє імʼя — 37'));
  assert.ok(withIntro.includes('не назвав сервіс — 39'));
});

test('усі представились — блока немає', () => {
  const r = headerText({ name: 'Роман', stats: stats({ callCount: 5, introChecked: 5 }), start: new Date(), end: new Date() });
  assert.ok(!r.includes('Не представився'));
});

test('нічого не перевірено — блока теж немає', () => {
  const r = headerText({ name: 'Роман', stats: stats({ callCount: 5, introChecked: 0, introNoName: 0 }), start: new Date(), end: new Date() });
  assert.ok(!r.includes('Не представився'));
});

test('модель отримує правила з того самого модуля, що й офлайн-детектор', () => {
  assert.ok(/import \{[^}]*introRules[^}]*\} from '\.\/managerIntro\.js';/.test(analyzeJs));
  assert.ok(analyzeJs.includes("required: ['callPurpose', 'intro', 'items']"));
});

test('представлення зберігається і на НЕпродажному дзвінку', () => {
  assert.ok(/if \(callPurpose !== 'sales'\) return \{ version: ANALYSIS_VERSION, callPurpose, intro, items: \[\] \};/.test(analyzeJs));
});

test('беклог представлення не імпортує ЖОДНОГО платного модуля', () => {
  for (const paid of ['openai', 'elevenlabs', 'transcribe', 'analyzeCall', 'binotel']) {
    assert.ok(!new RegExp(`from '[^']*${paid}`, 'i').test(backfillJs), `беклог тягне платний модуль: ${paid}`);
  }
});

test('жодних керуючих символів у файлах представлення', () => {
  for (const [file, src] of [['app.js', appJs], ['managerIntro.js', readSrc('core/managerIntro.js')]]) {
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(src), `керуючі символи у ${file}`);
  }
});
