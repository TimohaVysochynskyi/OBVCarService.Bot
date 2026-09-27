import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, orphanClasses, allRepos } from '../../helpers/repo.js';
import { renderGlobalReport } from '../../../src/features/reporting/globalReportHtml.js';
import { lineInfo, LINE_KINDS } from '../../../src/domain/call/phoneLines.js';
import { buildLines } from '../../../src/features/reporting/globalReportData.js';

const months = [
  { key: '2026-06', title: 'червень 2026' },
  { key: '2026-07', title: 'липень 2026' },
];
const bucket = (o = {}) => ({ calls: 0, sales: 0, info: 0, other: 0, personal: 0, success: 0, reachable: 0, conversion: null, avgScore: null, ...o });
const lb = (o = {}) => ({ calls: 0, incoming: 0, outgoing: 0, sales: 0, success: 0, ...o });
const mgr = (name, display, unknown, all, m6) => ({
  name, display, unknown,
  byMonth: { '2026-06': lb(m6), '2026-07': lb(), all: lb(all) },
});

const lines = [
  {
    number: '901', kind: 'shared', name: null, phone: '0754738200',
    byMonth: {
      '2026-06': lb({ calls: 60, incoming: 58, outgoing: 2, sales: 9, success: 4 }),
      '2026-07': lb({ calls: 40, incoming: 39, outgoing: 1, sales: 3, success: 1 }),
      all: lb({ calls: 100, incoming: 97, outgoing: 3, sales: 12, success: 5 }),
    },
    managers: [
      mgr('Андрій', 'Андрій', false, { calls: 36, incoming: 36, outgoing: 0 }, { calls: 20, incoming: 20 }),
      mgr('Роман', 'Роман', false, { calls: 32, incoming: 32, outgoing: 0 }, { calls: 18, incoming: 18 }),
      mgr('Володимир', 'Володимир', false, { calls: 7, incoming: 7, outgoing: 0 }, { calls: 4, incoming: 4 }),
      mgr('901', LINE_KINDS.unknown.title, true, { calls: 25, incoming: 22, outgoing: 3 }, { calls: 18, incoming: 16, outgoing: 2 }),
    ],
  },
  {
    number: '902', kind: 'shared', name: null, phone: '0774738200',
    byMonth: {
      '2026-06': lb({ calls: 12, incoming: 10, outgoing: 2 }),
      '2026-07': lb(),
      all: lb({ calls: 12, incoming: 10, outgoing: 2 }),
    },
    managers: [
      mgr('Роман', 'Роман', false, { calls: 4, incoming: 4, outgoing: 0 }, { calls: 4, incoming: 4 }),
      mgr('Андрій', 'Андрій', false, { calls: 1, incoming: 1, outgoing: 0 }, { calls: 1, incoming: 1 }),
      mgr('902', LINE_KINDS.unknown.title, true, { calls: 7, incoming: 5, outgoing: 2 }, { calls: 7, incoming: 5, outgoing: 2 }),
    ],
  },
  {
    number: '903', kind: 'personal', name: 'Роман', phone: '0734738200',
    byMonth: {
      '2026-06': lb({ calls: 800, incoming: 400, outgoing: 400 }),
      '2026-07': lb({ calls: 711, incoming: 419, outgoing: 292 }),
      all: lb({ calls: 1511, incoming: 819, outgoing: 692, sales: 200, success: 90 }),
    },
  },
  {
    number: '904', kind: 'personal', name: 'Андрій', phone: '0504738201',
    byMonth: { '2026-06': lb({ calls: 151, incoming: 41, outgoing: 110 }), '2026-07': lb(), all: lb({ calls: 151, incoming: 41, outgoing: 110 }) },
  },
  {
    number: '905', kind: 'personal', name: 'Володимир', phone: '0674572011',
    byMonth: { '2026-06': lb({ calls: 135, incoming: 106, outgoing: 29 }), '2026-07': lb(), all: lb({ calls: 135, incoming: 106, outgoing: 29 }) },
  },
];

const report = {
  generatedAt: '2026-09-23T10:00:00.000Z',
  period: { start: '2026-06-19T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z' },
  totals: { calls: 1880, seconds: 142200, hours: 39.5, managers: 3, purposes: { sales: 218, info: 567, other: 1086, personal: 9 } },
  months,
  lines,
  directions: {
    sales: { incoming: 118, outgoing: 100, unknown: 0 },
    info: { incoming: 321, outgoing: 246, unknown: 0 },
    other: { incoming: 624, outgoing: 462, unknown: 0 },
    personal: { incoming: 9, outgoing: 0, unknown: 0 },
  },
  managers: [{ name: 'Роман', display: 'Роман', byMonth: { all: bucket({ calls: 10 }) }, strengths: [], weaknesses: [], analysedDays: 1, days: 1, partial: false }],
  stages: [],
  declines: { buckets: {}, bucketTitles: {}, serviceTotal: 0, cases: [], reasons: [], coverage: { notBooked: 0 } },
};

const html = renderGlobalReport(report);
const css = readSrc('features/reporting/site/app.css');
const appJs = readSrc('features/reporting/site/app.js');
const card901 = html.slice(html.indexOf('data-line="901"'), html.indexOf('data-line="902"'));
const catTable = html.slice(html.indexOf('Категорії дзвінків'), html.indexOf('Номери'));
const flat = html.replace(/\s+/g, ' ').replace(/> </g, '><');
const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));

const row = (number, manager, month, o = {}) => ({ number, manager, month, calls: 0, incoming: 0, outgoing: 0, sales: 0, success: 0, ...o });
const built = buildLines(
  [row('901', null, '2026-06', { calls: 100 }), row('902', null, '2026-06', { calls: 12 })].map((r) => ({ ...r, manager: undefined })),
  [
    row('901', 'Андрій', '2026-06', { calls: 36, incoming: 36 }),
    row('901', 'Роман', '2026-06', { calls: 32, incoming: 32 }),
    row('901', 'Володимир', '2026-06', { calls: 7, incoming: 7 }),
    row('901', '901', '2026-06', { calls: 25, incoming: 22, outgoing: 3 }),
    row('902', 'Роман', '2026-06', { calls: 4, incoming: 4 }),
    row('902', '902', '2026-06', { calls: 7, incoming: 5, outgoing: 2 }),
  ],
  ['2026-06']
);
const built901 = built.find((l) => l.number === '901');
const built902 = built.find((l) => l.number === '902');

test('пʼять номерів; окремої картки «не розпізнано» більше немає', () => {
  const cards = [...html.matchAll(/data-line="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cards, ['901', '902', '903', '904', '905']);
});

test('стаціонарні — по дві в ряд', () => {
  assert.ok(/grid gap-3 sm:grid-cols-2">[\s\S]*?data-line="901"/.test(html));
});

test('персональні — по три в ряд', () => {
  assert.ok(/grid gap-3 sm:grid-cols-2 lg:grid-cols-3">[\s\S]*?data-line="903"/.test(html));
});

test('стаціонарні стоять першими — саме на них іде реклама', () => {
  assert.ok(html.indexOf('data-line="901"') < html.indexOf('data-line="903"'));
});

test('стаціонарний підписаний без імені, персональний — з іменем менеджера', () => {
  const card = (num) => html.slice(html.indexOf(`data-line="${num}"`), html.indexOf(`data-line="${num}"`) + 900);
  assert.ok(card('901').includes('Стаціонарний') && !card('901').includes('·'));
  assert.ok(card('903').includes('Персональний · Роман'));
});

test('номер лінії — у місцевому форматі 0XX XXX XX XX', () => {
  for (const [ext, phone] of [['901', '075 473 82 00'], ['903', '073 473 82 00'], ['905', '067 457 20 11']]) {
    const card = html.slice(html.indexOf(`data-line="${ext}"`), html.indexOf(`data-line="${ext}"`) + 700);
    assert.ok(card.includes(phone), `у картці ${ext} немає номера ${phone}`);
  }
});

test('номер притиснутий праворуч, одразу перед значком «i»', () => {
  const head901 = html.slice(html.indexOf('data-line="901"'), html.indexOf('data-line-sub'));
  assert.ok(head901.indexOf('СТАЦІОНАРНИЙ') < head901.indexOf('075 473 82 00'));
  assert.ok(head901.indexOf('075 473 82 00') < head901.indexOf('data-tip'));
  assert.ok(/ml-auto[^>]*>075 473 82 00/.test(head901));
});

test('у картках немає залишків формату +380', () => {
  assert.ok(!/\+380\d{9}/.test(html.slice(html.indexOf('data-line="901"'), html.indexOf('Аудіо'))));
});

test('текст під «Номери» — дослівно той, що задав клієнт', () => {
  assert.ok(html.includes('Скільки дзвінків надійшло на кожен номер і яку частку вони становлять від усіх дзвінків. Першими показані номери, які використовуються в рекламі.'));
});

test('рядок картки переноситься на вузькому екрані', () => {
  assert.ok(/flex flex-wrap items-center/.test(html));
});

test('колонки таблиці — менеджери, нерозпізнані ОСТАННЬОЮ', () => {
  const cols = [...new Set([...card901.matchAll(/data-lm-name="([^"]+)"/g)].map((m) => m[1]))];
  assert.deepEqual(cols, ['Андрій', 'Роман', 'Володимир', '901']);
});

test('нерозпізнана колонка підписана «None»', () => {
  assert.equal(LINE_KINDS.unknown.title, 'None');
  assert.ok(card901.includes('>None<'));
});

test('колонка менеджера не зникає з лінії, де в нього нуль дзвінків', () => {
  assert.deepEqual(built901.managers.map((m) => m.name), ['Андрій', 'Роман', 'Володимир', '901']);
  assert.deepEqual(built902.managers.map((m) => m.name), ['Андрій', 'Роман', 'Володимир', '902']);
});

test('його колонка показує нуль, а не порожнечу', () => {
  const zero = built902.managers.find((m) => m.name === 'Володимир');
  assert.equal(zero.byMonth.all.calls, 0);
  assert.equal(zero.byMonth['2026-06'].calls, 0);
});

test('нерозпізнана колонка лишається останньою на обох лініях', () => {
  assert.equal(built902.managers.at(-1).display, 'None');
});

test('рядки — Угоди, Записи, Усього, і під ним вхідні/вихідні', () => {
  const fields = [...new Set([...card901.matchAll(/data-lm-field="([^"]+)"/g)].map((m) => m[1]))];
  assert.deepEqual(fields, ['sales', 'success', 'calls', 'incoming', 'outgoing']);
});

test('рядок «Усього» обведений з обох боків і весь жирний', () => {
  assert.ok(/<tr class="border-y border-line font-bold">[\s\S]{0,200}?>Усього</.test(card901));
});

test('таблицю перейменовано на «Розподіл дзвінків»', () => {
  assert.ok(card901.includes('Розподіл дзвінків') && !card901.includes('Хто брав слухавку'));
});

test('вхідні/вихідні стоять ПІД «Усього» — як його розбивка', () => {
  let at = -1;
  for (const label of ['Угоди', 'Записи', 'Усього', 'вхідні', 'вихідні']) {
    const i = card901.indexOf(`${label}</th>`);
    assert.ok(i > at, `порядок рядків порушено на: ${label}`);
    at = i;
  }
});

test('рядки розкладу сумуються рівно в підсумок картки', () => {
  const sums = lines[0].managers.reduce((n, m) => n + m.byMonth.all.calls, 0);
  assert.equal(sums, lines[0].byMonth.all.calls);
});

test('записи скрізь рахуються тим самим фільтром, що й угоди', () => {
  assert.ok(!/FILTER \(WHERE is_success\)/.test(allRepos()),
    'десь лишився голий is_success — записів вийде більше, ніж угод');
});

test('у персонального номера таблиці немає', () => {
  const card903 = html.slice(html.indexOf('data-line="903"'), html.indexOf('data-line="904"'));
  assert.ok(!card903.includes('data-lm-field'));
});

test('окремої картки зрізу немає — нерозпізнані живуть колонкою всередині 901 і 902', () => {
  assert.ok(!html.includes('data-line="unknown"') && !html.includes('border-dashed'));
});

test('усі хуки номерів читаються скриптом', () => {
  const HOOKS = ['data-line', 'data-lm-line', 'data-lm-name', 'data-lm-field', 'data-line-tab',
    'data-line-in', 'data-line-out', 'data-line-bar-in', 'data-line-bar-out', 'data-line-sub'];
  for (const hook of HOOKS) {
    assert.ok(html.includes(hook), `розмітка не віддає ${hook}`);
    const camel = hook.replace(/^data-/, '').replace(/-(.)/g, (_, c) => c.toUpperCase());
    assert.ok(appJs.includes(hook) || appJs.includes(camel), `скрипт не читає ${hook}`);
  }
});

test('числа картки лишаються порожніми в розмітці — їх ставить скрипт', () => {
  assert.ok(/data-line-in><\/span>/.test(card901) && /data-line-sub><\/div>/.test(card901));
});

test('перемикач місяців для номерів: «Весь період» останній і обраний', () => {
  const lineTabs = [...html.matchAll(/data-line-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(lineTabs, ['2026-06', '2026-07', 'all']);
  assert.ok(/data-line-tab="all" aria-selected="true"/.test(html));
});

test('кожна категорія має і загальну кількість, і вхідні з вихідними', () => {
  for (const [count, inc, out] of [[218, 118, 100], [567, 321, 246], [1086, 624, 462]]) {
    assert.ok(flat.includes(`>${count}</td>`), `немає підсумку ${count}`);
    assert.ok(flat.includes(`>${inc}</td>`) && flat.includes(`>${out}</td>`), `немає розбивки ${inc}/${out}`);
  }
});

test('таблиця категорій має природну ширину, а не розтягнута на 100%', () => {
  assert.ok(/<table class="w-auto border-collapse/.test(catTable));
  assert.ok(!/<table class="w-full[^"]*">[\s\S]{0,200}Категорія/.test(catTable));
});

test('на вузькому екрані вона прокручується, а не ламає верстку', () => {
  assert.ok(/overflow-x-auto[^>]*><table class="w-auto/.test(catTable));
});

test('діаграма й таблиця переносяться одна під одну на телефоні', () => {
  assert.ok(/flex flex-wrap items-center gap-6/.test(catTable));
});

test('підсумковий рядок сумує вхідні й вихідні по всіх категоріях', () => {
  const foot = flat.slice(flat.indexOf('<tfoot>'), flat.indexOf('</tfoot>'));
  assert.ok(foot.includes('>1880</td>') && foot.includes('>1072</td>') && foot.includes('>808</td>'),
    `підсумковий рядок: ${foot.slice(0, 300)}`);
});

test('кольори категорій ті, що просив клієнт', () => {
  assert.ok(html.includes('background:#3b6fb0') && html.includes('background:#2f7d58'));
  assert.ok(html.includes('background:#8c5aa8') && html.includes('background:#7b5334'));
});

test('у секції категорій не лишилось жодного емоджі', () => {
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(catTable));
});

test('стрілки — SVG: вхідні зелені, вихідні сині', () => {
  const arrows = [...html.matchAll(/<svg viewBox="0 0 16 16"[^>]*style="color:(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.ok(arrows.includes('#2f7d58') && arrows.includes('#1d4ed8'));
  assert.ok(!arrows.includes('#9aa6b8'));
});

test('смужка в картці тих самих кольорів, що й стрілки', () => {
  assert.ok(html.includes('style="background:#2f7d58" data-line-bar-in') && html.includes('style="background:#1d4ed8" data-line-bar-out'));
});

test('підсумок картки чорний', () => {
  assert.ok(html.includes('class="mt-1 text-sm text-ink" data-line-sub'));
});

test('числа в підсумку виводяться жирними', () => {
  assert.ok(/<b>' \+ calls \+ '<\/b>/.test(appJs) || appJs.includes("'<b>' + calls + '</b> '"));
});

test('телефон приглушений, не чорний', () => {
  assert.ok(/tabular-nums text-muted">075 473 82 00/.test(html));
});

test('«97 вхідних» приглушене, і число не жирне', () => {
  assert.ok(/text-sm tabular-nums text-muted">[\s\S]{0,400}?<span data-line-in><\/span>/.test(html));
});

test('секції «Категорії дзвінків» і «Номери» розділені лінією', () => {
  assert.ok(/<div class="mt-6 border-t border-line pt-5"><\/div>\s*<h2/.test(html));
});

test('заголовок «Номери» у стилі «Категорії дзвінків»', () => {
  assert.ok(/<h2 class="text-lg sm:text-xl font-semibold mb-3">Номери<\/h2>/.test(html));
});

test('ряд заголовків таблиці категорій жирний', () => {
  const catHead = /<tr class="([^"]*)">\s*<th[^>]*>Категорія/.exec(html)[1];
  assert.ok(catHead.includes('font-bold'));
});

test('у таблиці категорій є вертикальні розділювачі', () => {
  assert.ok((catTable.match(/border-l border-line/g) || []).length >= 12);
});

test('шапка несе той самий контент, що й задав клієнт', () => {
  assert.ok(header.includes('Аналітика дзвінків'));
  assert.ok(header.includes('19.06 — 22.09.26'));
  assert.ok(header.includes('39.5') && header.includes('1880'));
});

test('на телефоні шапка складається в колонку', () => {
  assert.ok(/flex-col[\s\S]{0,80}md:flex-row/.test(header));
});

test('використано токен документа text-ink, а не сирий text-black', () => {
  assert.ok(!header.includes('text-black'));
});

test('заголовку задано leading-tight', () => {
  assert.ok(!/leading-6\b/.test(header) && header.includes('leading-tight'));
});

test('між блоками шапки зʼявився роздільник', () => {
  assert.ok(header.includes('md:border-l'));
});

test('абзац не вилазить за межі флекс-контейнера', () => {
  assert.ok(header.includes('min-w-0'));
});

test('CDN-скрипт Tailwind у генераторі відсутній', () => {
  assert.ok(!/cdn\.jsdelivr|cdn\.tailwindcss/.test(html));
});

test('ширина контейнера — як у макеті клієнта', () => {
  assert.ok(html.includes('max-w-7xl'));
});

test('кожен клас сторінки з номерами має правило в зібраному CSS', () => {
  const { orphans } = orphanClasses(html, css, appJs);
  assert.deepEqual(orphans, [], `класи без правила в CSS: ${orphans.join(', ')}`);
});

test('domain/call/phoneLines знає, що є що', () => {
  assert.equal(lineInfo('901').kind, 'shared');
  assert.equal(lineInfo('903').name, 'Роман');
  assert.equal(lineInfo('0674738200').kind, 'other');
});

test('інжест читає ті самі константи, а не власну копію', () => {
  const ingest = readSrc('features/ingest/process.js');
  assert.match(ingest, /from '[^']*\/phoneLines\.js'/);
  assert.ok(!/const (SHARED_EXTENSIONS|PERSONAL_OPERATORS|EXCLUDED_EXTENSIONS) =/.test(ingest));
});
