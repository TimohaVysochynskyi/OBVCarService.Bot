import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGlobalReport } from '../../src/bot/globalReportHtml.js';

const bucket = (o = {}) => ({ calls: 0, sales: 0, info: 0, other: 0, personal: 0, success: 0, reachable: 0, conversion: null, avgScore: null, ...o });
const months = [
  { key: '2026-06', title: 'червень 2026' },
  { key: '2026-07', title: 'липень 2026' },
  { key: '2026-08', title: 'серпень 2026' },
];
const manager = (name, byMonth) => ({
  name, display: name, byMonth, strengths: [], weaknesses: [], analysedDays: 3, days: 3, partial: false,
});

const report = {
  generatedAt: '2026-09-22T10:00:00.000Z',
  period: { start: '2026-06-19T00:00:00.000Z', end: '2026-08-31T00:00:00.000Z' },
  totals: { calls: 100, seconds: 36000, hours: 10, managers: 3, purposes: { sales: 40, info: 30, other: 20, personal: 10 } },
  months,
  managers: [
    manager('Роман', {
      '2026-06': bucket({ calls: 30, sales: 10, success: 3, reachable: 9, conversion: 33, avgScore: 6.1 }),
      '2026-07': bucket({ calls: 28, sales: 8, success: 4, reachable: 8, conversion: 50, avgScore: 7.4 }),
      '2026-08': bucket({ calls: 25, sales: 6, success: 4, reachable: 6, conversion: 67, avgScore: 8.2 }),
      all: bucket({ calls: 83, sales: 24, success: 11, reachable: 23, conversion: 48, avgScore: 7.2 }),
    }),
    manager('Андрій', {
      '2026-06': bucket({ calls: 10, sales: 4, success: 1, reachable: 4, conversion: 25, avgScore: 5.5 }),
      all: bucket({ calls: 18, sales: 6, success: 3, reachable: 6, conversion: 50, avgScore: 5.8 }),
    }),
    manager('Володимир', { all: bucket({ calls: 5 }) }),
  ],
  stages: [{ stage: 'закриття угоди', count: 5 }],
  declines: {
    buckets: { no_slot: 1, no_parts: 0, out_of_scope: 0 },
    bucketTitles: { no_slot: 'Немає вільного місця', no_parts: 'Відсутність деталей', out_of_scope: 'Не наш профіль' },
    serviceTotal: 1,
    cases: [],
    reasons: [{ key: 'busy', label: 'зайнято', side: 'service', count: 1 }],
    coverage: { notBooked: 10, notBookedBlocked: 1, clientExplained: 5, unchecked: 4 },
  },
};

const html = renderGlobalReport(report);
const colourOf = (name) => {
  const row = html.slice(html.indexOf(`data-cmp="conv" data-manager="${name}"`));
  return /background:(#[0-9a-f]{6})/.exec(row)[1];
};
const roman = colourOf('Роман');
const charts = [...html.matchAll(/<svg viewBox="0 0 (\d+) (\d+)"[\s\S]*?<\/svg>/g)].filter((c) => c[0].includes('chart-grid'));

test('порядок менеджерів у кожному показнику той самий, що й у табах', () => {
  const order = report.managers.map((m) => m.name);
  for (const metric of ['conv', 'score', 'sales']) {
    const seen = [...html.matchAll(new RegExp(`data-cmp="${metric}" data-manager="([^"]+)"`, 'g'))].map((m) => m[1]);
    assert.deepEqual(seen, order, metric);
  }
});

test('у кожного менеджера свій колір', () => {
  assert.notEqual(roman, colourOf('Андрій'));
  assert.notEqual(roman, colourOf('Володимир'));
});

test('той самий колір несе його лінія на графіку', () => {
  assert.ok(html.includes(`stroke="${roman}"`));
});

test('два графіки: конверсія і бал', () => {
  assert.equal(charts.length, 2);
});

test('усі точки ліній — скінченні числа в межах полотна', () => {
  for (const [svg, w, h] of charts) {
    for (const pt of [...svg.matchAll(/points="([^"]+)"/g)]) {
      for (const pair of pt[1].split(' ')) {
        const [x, y] = pair.split(',').map(Number);
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `NaN у координатах: ${pair}`);
        assert.ok(x >= 0 && x <= Number(w) && y >= 0 && y <= Number(h), `точка поза полем: ${pair}`);
      }
    }
  }
});

test('менеджер без жодної угоди лінії не малює', () => {
  assert.ok(!charts[0][0].includes(colourOf('Володимир')));
});

test('зростання 33→50→67% справді піднімає лінію вгору', () => {
  const romanPts = /<polyline class="chart-line" points="([^"]+)" stroke="(#[0-9a-f]{6})"/.exec(charts[0][0]);
  assert.equal(romanPts[2], roman);
  const ys = romanPts[1].split(' ').map((p) => Number(p.split(',')[1]));
  assert.ok(ys[0] > ys[1] && ys[1] > ys[2], `зростання конверсії має йти вгору: ${ys.join(' ')}`);
});

test('на одному менеджері секція порівняння не показується взагалі', () => {
  const solo = renderGlobalReport({ ...report, managers: [report.managers[0]], totals: { ...report.totals, managers: 1 } });
  assert.ok(!solo.includes('Порівняння менеджерів'));
});
