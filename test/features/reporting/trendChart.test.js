import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../../helpers/repo.js';
import { el, makeDom, viewBoxWidth, pathYs } from '../../helpers/fakeDom.js';

const APP = readSrc('features/reporting/site/app.js');
const NAMES = ['Роман', 'Володимир', 'Андрій'];

const monthPoints = (seed) => [
  { label: 'чер', sales: seed, success: Math.round(seed / 2), conversion: 50, score: 6 },
  { label: 'лип', sales: seed * 2, success: seed, conversion: 60, score: 7 },
  { label: 'сер', sales: seed * 3, success: seed * 2, conversion: 70, score: 7.5 },
];

function buildPage(width) {
  const tabs = NAMES.map((name) => el('button', { 'data-manager-tab': name, 'aria-selected': 'false' }));
  const cards = NAMES.map((name) =>
    el('section', { 'data-manager-card': name, hidden: '' }, [
      el('button', { 'data-month-tab': 'all', 'data-month': 'all' }),
      el('button', { 'data-series': 'sales', 'aria-selected': 'true' }, [el('b', { 'data-series-val': 'sales' })]),
      el('button', { 'data-series': 'score', 'aria-selected': 'true' }, [el('b', { 'data-series-val': 'score' })]),
      el('div', { 'data-trend-note': '' }),
      el('svg', { 'data-trend': name }),
    ])
  );
  const root = el('body', {}, [...tabs, ...cards]);
  root.boxWidth = width;
  return { root, tabs, cards };
}

const data = {
  managers: Object.fromEntries(NAMES.map((n) => [n, { all: { calls: 10, sales: 4 } }])),
  series: Object.fromEntries(NAMES.map((n, i) => [n, { all: monthPoints(i + 2) }])),
  lines: {},
  lineManagers: {},
};

function boot(width) {
  const page = buildPage(width);
  const dom = makeDom(page.root, { data });
  dom.run(APP);
  dom.runFrames([0, 1000]);
  return { ...page, dom };
}

const trendOf = (card) => card.querySelector('[data-trend]');

test('графік видимої картки займає всю ширину контейнера', () => {
  const { cards } = boot(1150);
  assert.equal(viewBoxWidth(trendOf(cards[0])), 1150);
});

test('перемикання менеджера перемальовує графік під реальну ширину, а не під запасні 680', () => {
  const { tabs, cards, dom } = boot(1150);
  tabs[1].fire('click');
  dom.runFrames([0, 1000]);
  assert.equal(viewBoxWidth(trendOf(cards[1])), 1150);
});

test('усі три графіки мають однакову ширину після обходу вкладок', () => {
  const { tabs, cards, dom } = boot(980);
  const seen = [];
  tabs.forEach((tab, i) => {
    tab.fire('click');
    dom.runFrames([0, 1000]);
    seen.push(viewBoxWidth(trendOf(cards[i])));
  });
  assert.deepEqual(seen, [980, 980, 980]);
});

test('зміна розміру вікна підганяє графік під нову ширину', () => {
  const { root, cards, dom } = boot(1150);
  root.boxWidth = 360;
  dom.window.fire('resize');
  dom.runTimers();
  dom.runFrames([0, 1000]);
  assert.equal(viewBoxWidth(trendOf(cards[0])), 360);
});

test('на вузькому екрані графік не стискається до запасної ширини', () => {
  const { cards } = boot(300);
  assert.equal(viewBoxWidth(trendOf(cards[0])), 300);
});

test('підписів осі стає менше, коли графік вузький', () => {
  const wide = boot(1150);
  const narrow = boot(300);
  const labels = (svg) => (String(svg.innerHTML).match(/text-anchor="middle"/g) || []).length;
  assert.ok(labels(trendOf(narrow.cards[0])) <= labels(trendOf(wide.cards[0])));
});

test('лінії виїжджають з нижньої межі, а не зʼявляються на місці', () => {
  const { tabs, cards, dom } = boot(1150);
  tabs[1].fire('click');
  dom.runFrames([0]);
  const started = pathYs(trendOf(cards[1]));
  dom.runFrames([1000]);
  const settled = pathYs(trendOf(cards[1]));
  assert.ok(started.length > 0);
  assert.ok(started[0].every((y) => y === started[0][0]));
  assert.ok(settled[0].some((y, i) => y !== started[0][i]));
});

test('анімація доходить до кінця і завмирає на справжніх значеннях', () => {
  const { tabs, cards, dom } = boot(1150);
  tabs[1].fire('click');
  dom.runFrames([0, 420, 1000]);
  const settled = pathYs(trendOf(cards[1]));
  dom.runFrames([2000]);
  assert.deepEqual(pathYs(trendOf(cards[1])), settled);
  assert.equal(dom.pendingFrames(), 0);
});

test('наведення курсора не перезапускає анімацію', () => {
  const { cards, dom } = boot(1150);
  const svg = trendOf(cards[0]);
  const before = pathYs(svg);
  svg.fire('mousemove', { clientX: 400 });
  assert.equal(dom.pendingFrames(), 0);
  assert.deepEqual(pathYs(svg), before);
});
