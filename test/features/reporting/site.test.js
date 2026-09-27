import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, orphanClasses } from '../../helpers/repo.js';
import { renderGlobalReport } from '../../../src/features/reporting/globalReportHtml.js';

const bucket = (o = {}) => ({ calls: 0, sales: 0, info: 0, other: 0, personal: 0, success: 0, reachable: 0, conversion: null, avgScore: null, ...o });
const months = [
  { key: '2026-06', title: 'червень 2026' },
  { key: '2026-07', title: 'липень 2026' },
  { key: '2026-08', title: 'серпень 2026' },
];
const example = (quote, extra = {}) => ({ quote, note: null, at: '2026-06-23T10:42:22.000Z', callId: null, start: null, end: null, ...extra });
const finding = (claim, type, examples) => ({ claim, why: 'чому', action: 'що робити', type, examples });
const manager = (name, byMonth, strengths = [], weaknesses = []) => ({
  name, display: name, byMonth, strengths, weaknesses, analysedDays: 3, days: 3, partial: false,
});

const report = {
  generatedAt: '2026-09-22T10:00:00.000Z',
  period: { start: '2026-06-19T00:00:00.000Z', end: '2026-08-31T00:00:00.000Z' },
  totals: { calls: 100, seconds: 36000, hours: 10, managers: 3, purposes: { sales: 40, info: 30, other: 20, personal: 10 } },
  months,
  managers: [
    manager('Роман', {
      '2026-06': bucket({ calls: 30, sales: 10, success: 3, reachable: 9, conversion: 33, avgScore: 6.1 }),
      '2026-08': bucket({ calls: 25, sales: 6, success: 4, reachable: 6, conversion: 67, avgScore: 8.2 }),
      all: bucket({ calls: 83, sales: 24, success: 11, reachable: 23, conversion: 48, avgScore: 7.2 }),
    },
    [finding('Добре виявляє потребу', 'strength', [
      example('А що саме турбує?', { callId: 111, start: 12.5, end: 15.0, audio: 'audio/aaa111.mp3', audioSeconds: 11 }),
      example('Без таймкоду'),
    ])],
    [finding('Перебиває клієнта', 'error', [
      example('Зрозуміло, так ось —', { callId: 222, start: 40, end: 44, audio: 'audio/bbb222.mp3', audioSeconds: 10 }),
    ])]),
    manager('Андрій', { all: bucket({ calls: 18, sales: 6, success: 3, reachable: 6, conversion: 50, avgScore: 5.8 }) }),
    manager('Володимир', { all: bucket({ calls: 5, sales: 0, success: 0, reachable: 0 }) }),
  ],
  stages: [{ stage: 'закриття угоди', count: 5 }],
  declines: {
    buckets: { no_slot: 1, no_parts: 0, out_of_scope: 2 },
    bucketLabels: { no_slot: 'Черга', no_parts: 'Деталі', out_of_scope: 'Не наш профіль' },
    bucketTitles: { no_slot: 'Немає вільного місця', no_parts: 'Відсутність деталей', out_of_scope: 'Не наш профіль' },
    serviceTotal: 3,
    cases: [{ at: '2026-06-23T10:42:22.000Z', manager: 'Роман', bucket: 'no_slot', bucketLabel: 'Черга', reason: 'зайнято', quote: 'сьогодні все забито', clientName: 'Максим', clientPhone: '+380971112233' }],
    reasons: [{ key: 'busy', label: 'зайнято', side: 'service', count: 3 }, { key: 'price', label: 'ціна', side: 'client', count: 1 }],
    coverage: { notBooked: 10, notBookedBlocked: 3, clientExplained: 5, unchecked: 2 },
  },
};

const html = renderGlobalReport(report);
const css = readSrc('features/reporting/site/app.css');
const appJs = readSrc('features/reporting/site/app.js');

test('стилі й скрипт підключаються окремими файлами', () => {
  assert.ok(html.includes('<link rel="stylesheet" href="assets/app.css">'));
  assert.ok(html.includes('<script src="assets/app.js" defer></script>'));
});

test('у сторінці не лишилось жодного інлайн-style', () => {
  assert.ok(!/<style[\s>]/.test(html));
});

test('єдиний вбудований script — це дані, логіки в сторінці немає', () => {
  const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  assert.ok(scripts.some((s) => s.includes('application/json')) && scripts.some((s) => s.includes('src="assets/app.js"')));
});

test('числа сторінки їдуть у JSON, який читає app.js', () => {
  const data = JSON.parse(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(Object.keys(data.managers), ['Роман', 'Андрій', 'Володимир']);
  assert.equal(data.managers['Роман']['2026-06'].conversion, 33);
});

test('кожен клас розмітки має правило в зібраному CSS', () => {
  const { orphans } = orphanClasses(html, css, appJs);
  assert.deepEqual(orphans, [], `класи без жодного правила в CSS: ${orphans.join(', ')}`);
});

test('усі хуки розмітки читаються скриптом', () => {
  const HOOKS = [
    'data-manager-tab', 'data-manager-card', 'data-month-tab', 'data-cat',
    'data-compare-tab', 'data-cmp', 'data-cmp-bar', 'data-cmp-val', 'data-cmp-sub',
    'data-decline-tab', 'data-decline-month', 'data-tip',
    'data-clip', 'data-clip-play', 'data-clip-icon', 'data-clip-track', 'data-clip-fill', 'data-clip-time',
  ];
  for (const hook of HOOKS) {
    assert.ok(html.includes(hook), `розмітка не віддає хук ${hook}`);
    const camel = hook.replace(/^data-/, '').replace(/-(.)/g, (_, c) => c.toUpperCase());
    assert.ok(appJs.includes(camel) || appJs.includes(hook), `скрипт не використовує хук ${hook}`);
  }
});

test('у кожній групі вкладок рівно одна активна, і стан несе aria-selected', () => {
  const groups = [...html.matchAll(/role="tablist"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  assert.ok(groups.length >= 5, `груп вкладок: ${groups.length}`);
  for (const group of groups) {
    const on = (group.match(/aria-selected="true"/g) || []).length;
    assert.equal(on, 1, `у групі вкладок має бути рівно одна активна, а не ${on}`);
  }
  const { used } = orphanClasses(html, css, appJs);
  assert.ok(![...used].includes('on'), 'у розмітці лишився легасі-клас стану .on');
});

test('плеєр зʼявляється і під перевагою, і під недоліком', () => {
  const players = [...html.matchAll(/data-clip="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(players.sort(), ['audio/aaa111.mp3', 'audio/bbb222.mp3']);
});

test('тривалість фрагмента підписана', () => {
  assert.ok(html.includes('data-clip-length="0:11"'));
});

test('цитата без таймкоду лишається текстом, без порожнього плеєра', () => {
  const noTimecode = html.slice(html.indexOf('Без таймкоду'));
  assert.ok(!noTimecode.slice(0, 400).includes('data-clip='));
});

test('у сторінці немає undefined / NaN', () => {
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    assert.ok(!html.includes(bad), `у сторінку протік ${bad}`);
  }
});

test('порядок секцій збережено: менеджери → порівняння → відмови', () => {
  assert.ok(html.includes('Порівняння менеджерів') && html.includes('Найбільш поширені причини відмов'));
  assert.ok(html.indexOf('data-manager-card') < html.indexOf('Порівняння менеджерів'));
});

test('розділ «як це рахується» пояснює, звідки береться аудіо', () => {
  assert.ok(html.includes('Аудіо під прикладом'));
});

test('жодного зовнішнього посилання — сторінка тягне лише свої файли', () => {
  assert.equal(/https?:\/\//.test(html), false);
});
