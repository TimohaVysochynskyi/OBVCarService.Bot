import { ALL } from '../globalReportData.js';
import { clock, esc, shortMonth, tickLabel } from './format.js';
import { IN_COLOR, MANAGER_COLORS, OUT_COLOR, PURPOSE_COLORS, PURPOSE_ORDER, TAB } from './tokens.js';

function arrow(direction) {
  const path =
    direction === 'in'
      ? 'M13 3 5 11M5 5v6h6'
      : 'M3 13 11 5M5 5h6v6';
  const color = direction === 'in' ? IN_COLOR : OUT_COLOR;
  return `<svg viewBox="0 0 16 16" class="inline-block h-3.5 w-3.5 shrink-0 align-[-0.15em]" aria-hidden="true" style="color:${color}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const withAllLast = (months) => [...months, { key: ALL, title: 'Весь період' }];

function tabStrip(items, attr, activeKey) {
  const tabs = items
    .map(
      (m) =>
        `<button type="button" class="${TAB}" ${attr}="${esc(m.key)}" aria-selected="${m.key === activeKey}">${esc(m.title)}</button>`
    )
    .join('');
  return `<div class="flex flex-wrap gap-1.5 mb-4 no-print" role="tablist">${tabs}</div>`;
}

function tip(title, body) {
  return `<details data-tip class="relative shrink-0 no-print">
      <summary class="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-line text-[11px] font-bold text-muted select-none transition" title="Пояснення">i</summary>
      <div class="absolute right-0 top-7 z-20 w-56 rounded-xl border border-line bg-white p-3 text-left text-xs leading-relaxed text-muted shadow-lg">
        <b class="text-ink">${esc(title)}</b><br>${esc(body)}
      </div>
    </details>`;
}

function donut(purposes, total) {
  if (!total) return '';
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = PURPOSE_ORDER.filter((p) => purposes[p]).map((p) => {
    const length = (purposes[p] / total) * circumference;
    const arc = `<circle r="${radius}" cx="70" cy="70" fill="none" stroke="${PURPOSE_COLORS[p]}" stroke-width="22" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
    offset += length;
    return arc;
  });
  return `<svg viewBox="0 0 140 140" class="h-36 w-36 shrink-0" role="img" aria-label="Структура дзвінків">
      <g transform="rotate(-90 70 70)">${arcs.join('')}</g>
      <text x="70" y="66" text-anchor="middle" class="fill-ink text-[26px] font-bold">${total}</text>
      <text x="70" y="84" text-anchor="middle" class="fill-[#667085] text-[11px]">дзвінків</text>
    </svg>`;
}

function player(example) {
  if (!example.audio) return '';
  const length = clock(example.audioSeconds);
  return `<div class="mt-2 flex items-center gap-2 no-print" data-clip="${esc(example.audio)}" data-clip-length="${esc(length)}">
      <button type="button" data-clip-play aria-label="Прослухати фрагмент"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-white text-[10px] text-ink transition hover:bg-track">
        <span data-clip-icon>▶</span>
      </button>
      <div data-clip-track class="h-1.5 flex-1 cursor-pointer rounded-full bg-track">
        <div data-clip-fill class="h-full w-0 rounded-full bg-accent transition-[width] duration-100"></div>
      </div>
      <span data-clip-time class="w-14 shrink-0 text-right text-xs tabular-nums text-muted">${esc(length)}</span>
    </div>`;
}

function lineChart(managers, months, key, { max, suffix = '', title }) {
  if (!months.length) return '';
  const W = 340;
  const H = 180;
  const L = 42;
  const R = 12;
  const T = 14;
  const B = 34;
  const iw = W - L - R;
  const ih = H - T - B;
  const n = months.length;
  const px = (i) => (n === 1 ? L + iw / 2 : L + (i / (n - 1)) * iw);
  const py = (v) => T + ih - (Math.min(Math.max(v, 0), max) / max) * ih;

  const grid = [0, max / 4, max / 2, (max * 3) / 4, max]
    .map(
      (t) =>
        `<line x1="${L}" y1="${py(t).toFixed(1)}" x2="${W - R}" y2="${py(t).toFixed(1)}" class="chart-grid"/>` +
        `<text x="${L - 6}" y="${(py(t) + 3.5).toFixed(1)}" text-anchor="end" class="chart-axis">${esc(tickLabel(t) + suffix)}</text>`
    )
    .join('');

  const xlabels = months
    .map((m, i) => `<text x="${px(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="chart-axis">${esc(shortMonth(m.title))}</text>`)
    .join('');

  const series = managers
    .map((manager, mi) => {
      const color = MANAGER_COLORS[mi % MANAGER_COLORS.length];
      const pts = months
        .map((mo, i) => ({ i, v: (manager.byMonth[mo.key] || {})[key] }))
        .filter((p) => p.v != null);
      if (!pts.length) return '';
      const path = pts.map((p) => `${px(p.i).toFixed(1)},${py(p.v).toFixed(1)}`).join(' ');
      const line = pts.length > 1 ? `<polyline class="chart-line" points="${path}" stroke="${color}"/>` : '';
      const dots = pts
        .map((p) => `<circle cx="${px(p.i).toFixed(1)}" cy="${py(p.v).toFixed(1)}" r="3.5" fill="${color}"/>`)
        .join('');
      return line + dots;
    })
    .join('');

  return `<figure class="m-0 rounded-xl border border-line p-4">
      <figcaption class="mb-1.5 text-sm text-muted">${esc(title)}</figcaption>
      <svg viewBox="0 0 ${W} ${H}" class="block h-auto w-full" role="img" aria-label="${esc(title)}">${grid}${series}${xlabels}</svg>
    </figure>`;
}

function barList(items, { max }) {
  return items
    .map(
      (r) => `<li class="grid grid-cols-[1fr_auto] items-center gap-x-2.5 gap-y-1 py-1 sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
        <span class="text-sm">${esc(r.label)}</span>
        <span class="order-last col-span-2 h-2 overflow-hidden rounded-full bg-track sm:order-none sm:col-span-1">
          <i class="block h-full rounded-full ${r.side === 'client' ? 'bg-[#8a7a3f]' : 'bg-accent'}" style="width:${((r.count / max) * 100).toFixed(1)}%"></i>
        </span>
        <span class="text-sm font-semibold tabular-nums">${r.count}</span>
      </li>`
    )
    .join('');
}

export {
  arrow,
  barList,
  donut,
  lineChart,
  player,
  tabStrip,
  tip,
  withAllLast,
};
