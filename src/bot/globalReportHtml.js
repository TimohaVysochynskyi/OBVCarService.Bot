import { PURPOSE_LABELS } from '../core/callPurpose.js';
import { LINE_KINDS } from '../core/phoneLines.js';
import { formatPhone, formatLinePhone } from './operators.js';
import { ALL } from './globalReportData.js';


const PURPOSE_ORDER = ['sales', 'info', 'other', 'personal'];
const PURPOSE_COLORS = { sales: '#3b6fb0', info: '#2f7d58', other: '#8c5aa8', personal: '#7b5334' };
const MANAGER_COLORS = ['#2f7d58', '#3b6fb0', '#b5603a', '#8c5aa8', '#4f7a8c'];
const WORK_DAY_HOURS = 8;
const MONTH_NAMES = [
  'січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
  'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень',
];

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const pad2 = (n) => String(n).padStart(2, '0');

function formatDate(iso) {
  const d = new Date(iso);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

function formatDateShort(iso) {
  const d = new Date(iso);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${String(d.getUTCFullYear()).slice(2)}`;
}

function monthKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function monthTitle(key) {
  const [year, m] = key.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${year}`;
}

const shortMonth = (title) => title.split(' ')[0].slice(0, 3);

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function share(count, total) {
  if (!total) return '';
  const pct = (count / total) * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

const periodSpan = (from, to) => {
  const a = new Date(from);
  const b = new Date(to);
  return `${pad2(a.getUTCDate())}.${pad2(a.getUTCMonth() + 1)} — ${formatDateShort(b)}`;
};

const IN_COLOR = '#2f7d58';
const OUT_COLOR = '#1d4ed8';

function arrow(direction) {
  const path =
    direction === 'in'
      ? 'M13 3 5 11M5 5v6h6'
      : 'M3 13 11 5M5 5h6v6';
  const color = direction === 'in' ? IN_COLOR : OUT_COLOR;
  return `<svg viewBox="0 0 16 16" class="inline-block h-3.5 w-3.5 shrink-0 align-[-0.15em]" aria-hidden="true" style="color:${color}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const clock = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
};


const CARD = 'rounded-2xl border border-line bg-card p-4 sm:p-5 mb-4';
const H2 = 'text-lg sm:text-xl font-semibold mb-3';
const H3 = 'text-sm uppercase tracking-wide text-muted font-semibold mt-6 mb-3';
const LEAD = 'text-muted mb-4';
const TAB =
  'rounded-full border border-line bg-[#fafbfc] px-3 py-1.5 text-xs cursor-pointer transition ' +
  'hover:border-muted aria-selected:bg-accent aria-selected:border-accent aria-selected:text-white';

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


function categoryTable(purposes, directions, total) {
  const rows = PURPOSE_ORDER.map((p) => {
    const count = purposes[p] || 0;
    const dir = directions[p] || { incoming: 0, outgoing: 0 };
    return `<tr class="border-b border-line last:border-0">
        <th scope="row" class="py-2 pr-2 text-left font-normal">
          <span class="mr-2 inline-block h-3 w-3 shrink-0 rounded-sm align-middle" style="background:${PURPOSE_COLORS[p]}"></span>${esc(PURPOSE_LABELS[p].plural)}
        </th>
        <td class="border-l border-line px-2 py-2 text-right font-semibold tabular-nums">${count}</td>
        <td class="border-l border-line px-2 py-2 text-right tabular-nums">${esc(share(count, total))}</td>
        <td class="border-l border-line px-2 py-2 text-right tabular-nums">${dir.incoming}</td>
        <td class="border-l border-line px-2 py-2 text-right tabular-nums">${dir.outgoing}</td>
      </tr>`;
  }).join('');

  const totalIn = PURPOSE_ORDER.reduce((n, p) => n + (directions[p]?.incoming || 0), 0);
  const totalOut = PURPOSE_ORDER.reduce((n, p) => n + (directions[p]?.outgoing || 0), 0);

  return `<div class="-mx-1 max-w-full overflow-x-auto px-1"><table class="w-auto border-collapse text-sm">
      <thead class="text-muted">
        <tr class="border-b border-line font-bold text-ink">
          <th class="py-2 pr-2 text-left">Категорія</th>
          <th class="border-l border-line px-2 py-2 text-right">Усього</th>
          <th class="border-l border-line px-2 py-2 text-right">Частка</th>
          <th class="border-l border-line px-2 py-2 text-right whitespace-nowrap">${arrow('in')} Вхідні</th>
          <th class="border-l border-line px-2 py-2 text-right whitespace-nowrap">${arrow('out')} Вихідні</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="border-t-2 border-line font-bold">
          <th scope="row" class="py-2 pr-2 text-left">Разом</th>
          <td class="border-l border-line px-2 py-2 text-right tabular-nums">${total}</td>
          <td class="border-l border-line px-2 py-2 text-right tabular-nums">100%</td>
          <td class="border-l border-line px-2 py-2 text-right tabular-nums">${totalIn}</td>
          <td class="border-l border-line px-2 py-2 text-right tabular-nums">${totalOut}</td>
        </tr>
      </tfoot>
    </table></div>`;
}

const LM_ROWS = [
  { field: 'sales', label: 'Угоди' },
  { field: 'success', label: 'Записи' },
  { field: 'calls', label: 'Усього', strong: true },
  { field: 'incoming', label: 'вхідні', sub: true, arrow: 'in' },
  { field: 'outgoing', label: 'вихідні', sub: true, arrow: 'out' },
];

function lineManagerTable(line) {
  if (!line.managers || !line.managers.length) return '';

  const head = line.managers
    .map(
      (m) =>
        `<th class="px-1 pb-1 text-right align-bottom font-semibold${m.unknown ? ' text-muted' : ''}">${esc(m.display)}</th>`
    )
    .join('');

  const body = LM_ROWS.map((row) => {
    const cells = line.managers
      .map(
        (m) => `<td class="px-1 py-1 text-right tabular-nums${row.strong ? ' font-semibold' : ''}"
            data-lm-line="${esc(line.number)}" data-lm-name="${esc(m.name)}" data-lm-field="${row.field}"></td>`
      )
      .join('');
    const cls = [
      row.strong ? 'border-y border-line font-bold' : '',
      row.sub ? 'text-muted' : '',
    ].filter(Boolean).join(' ');
    const label = row.arrow ? `${arrow(row.arrow)} ${esc(row.label)}` : esc(row.label);
    return `<tr class="${cls}">
        <th scope="row" class="py-1 pr-2 text-left whitespace-nowrap${row.strong ? '' : ' font-normal'}${row.sub ? ' pl-3' : ''}">${label}</th>
        ${cells}
      </tr>`;
  }).join('');

  return `<div class="mt-4 border-t border-line pt-3">
      <div class="mb-1.5 text-xs uppercase tracking-wide text-muted">Розподіл дзвінків</div>
      <div class="-mx-1 overflow-x-auto px-1">
        <table class="w-full border-collapse text-xs sm:text-sm">
          <thead class="text-muted"><tr><th></th>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function lineCard(line) {
  const kind = LINE_KINDS[line.kind] || LINE_KINDS.other;
  const subtitle = line.name ? `${kind.title} · ${esc(line.name)}` : kind.title;

  return `<article class="rounded-xl border border-line p-3.5" data-line="${esc(line.number)}">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="text-xl font-bold tabular-nums">${esc(line.number)}</span>
        <span class="text-xs uppercase tracking-wide text-muted">${subtitle}</span>
        ${line.phone ? `<span class="ml-auto font-medium tabular-nums text-muted">${esc(formatLinePhone(line.phone))}</span>` : '<span class="ml-auto"></span>'}
        ${tip(`${kind.title} номер ${line.number}`, kind.about)}
      </div>
      <div class="mt-1 text-sm text-ink" data-line-sub></div>
      <div class="mt-3 flex h-2.5 overflow-hidden rounded-full bg-track">
        <span class="block h-full transition-[width] duration-300" style="background:${IN_COLOR}" data-line-bar-in></span>
        <span class="block h-full transition-[width] duration-300" style="background:${OUT_COLOR}" data-line-bar-out></span>
      </div>
      <div class="mt-2 flex items-baseline justify-between gap-2 text-sm tabular-nums text-muted">
        <span>${arrow('in')} <span data-line-in></span> вхідних</span>
        <span>${arrow('out')} <span data-line-out></span> вихідних</span>
      </div>
      ${lineManagerTable(line)}
    </article>`;
}

function linesSection(report) {
  const lines = (report.lines || []).filter((l) => l.kind !== 'unknown');
  if (!lines.length) return '';
  const shared = lines.filter((l) => l.kind === 'shared');
  const rest = lines.filter((l) => l.kind !== 'shared');

  const grid = (items, cols) =>
    items.length ? `<div class="grid gap-3 ${cols}">${items.map(lineCard).join('')}</div>` : '';

  return `<div class="mt-6 border-t border-line pt-5"></div>
    <h2 class="${H2}">Номери</h2>
    <p class="${LEAD}">Скільки дзвінків надійшло на кожен номер і яку частку вони становлять від усіх дзвінків. Першими показані номери, які використовуються в рекламі.</p>
    ${tabStrip(withAllLast(report.months), 'data-line-tab', ALL)}
    ${grid(shared, 'sm:grid-cols-2')}
    ${shared.length && rest.length ? '<div class="h-3"></div>' : ''}
    ${grid(rest, 'sm:grid-cols-2 lg:grid-cols-3')}`;
}


const INTRO_COLOR = '#2f7d58';

function introBar(field, label) {
  return `<div class="mt-2">
      <div class="flex items-baseline justify-between gap-2 text-sm">
        <span class="text-muted">${esc(label)}</span>
        <span class="tabular-nums" data-intro-pct="${field}"></span>
      </div>
      <div class="mt-1 h-2 w-full overflow-hidden rounded-full bg-line">
        <div class="h-full rounded-full" style="background:${INTRO_COLOR};width:0%" data-intro-bar="${field}"></div>
      </div>
    </div>`;
}

function introCard(manager) {
  return `<article class="rounded-xl border border-line p-3" data-intro-card="${esc(manager.name)}">
      <div class="flex items-baseline gap-2">
        <span class="text-xs uppercase tracking-wide text-muted">Менеджер</span>
        <span class="font-semibold">${esc(manager.display)}</span>
      </div>
      <div class="mt-1 text-sm text-ink" data-intro-sub></div>
      ${introBar('name', 'назвав своє імʼя')}
      ${introBar('company', 'назвав сервіс')}
      <div class="mt-2 text-sm tabular-nums text-muted" data-intro-dir></div>
    </article>`;
}

function introSection(report) {
  const intro = report.intro;
  if (!intro?.managers?.length || !intro.total?.checked) return '';
  return `<section class="${CARD}">
    <h2 class="${H2}">Представлення</h2>
    <p class="${LEAD}">Чи називає менеджер своє імʼя та назву сервісу на початку розмови — і на вхідному дзвінку, і на вихідному. Рахується лише на персональних номерах: на стаціонарних саме представлення й дозволяє визначити, хто взяв слухавку, тож там непредставлені дзвінки вже видно як «None» у розділі «Номери».</p>
    ${tabStrip(withAllLast(report.months), 'data-intro-tab', ALL)}
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${intro.managers.map(introCard).join('')}</div>
  </section>`;
}


const SERIES = [
  { key: 'sales', title: 'Угоди', color: '#3b6fb0', axis: 'left' },
  { key: 'success', title: 'Записи', color: '#2f7d58', axis: 'left' },
  { key: 'conversion', title: 'Конверсія', color: '#b5603a', axis: 'right', suffix: '%' },
  { key: 'score', title: 'Бал', color: '#8c5aa8', axis: 'right' },
];

function categoryStrip(manager) {
  const total = manager.byMonth[ALL] || {};
  const segments = PURPOSE_ORDER.map(
    (p) => `<div class="h-full" style="background:${PURPOSE_COLORS[p]};width:0%" data-cat-seg="${p}"></div>`
  ).join('');
  const legend = PURPOSE_ORDER.map(
    (p) => `<div class="flex items-start gap-2">
        <span class="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm" style="background:${PURPOSE_COLORS[p]}"></span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs uppercase tracking-wide text-muted">${esc(PURPOSE_LABELS[p].plural)}</div>
          <div class="text-sm"><b class="tabular-nums" data-cat="${p}">${total[p] || 0}</b> <span class="tabular-nums text-muted" data-cat-share="${p}"></span></div>
        </div>
        ${tip(PURPOSE_LABELS[p].plural, PURPOSE_LABELS[p].about)}
      </div>`
  ).join('');

  return `<div class="rounded-xl border border-line p-3">
      <div class="flex h-3 w-full overflow-hidden rounded-full bg-track">${segments}</div>
      <div class="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">${legend}</div>
    </div>`;
}

function trendBlock(manager) {
  const legend = SERIES.map(
    (sr) => `<button type="button" class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm cursor-pointer transition hover:bg-[#f2f5f9] aria-selected:bg-[#eef2f7]" data-series="${sr.key}" aria-selected="true">
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:${sr.color}"></span>
        <span class="text-muted">${esc(sr.title)}</span>
        <b class="tabular-nums" data-series-val="${sr.key}"></b>
      </button>`
  ).join('');

  return `<h3 class="${H3}">Динаміка</h3>
    <div class="rounded-xl border border-line p-3">
      <div class="flex flex-wrap items-center gap-1 no-print">${legend}</div>
      <div class="mt-1 text-xs text-muted" data-trend-note></div>
      <svg class="mt-2 block w-full" role="img" data-trend="${esc(manager.name)}"></svg>
    </div>`;
}

function findingBlock(finding, kind) {
  const dot = kind === 'plus' ? 'bg-plus' : 'bg-minus';
  const quoteBorder = kind === 'plus' ? 'border-plus/40' : 'border-minus/40';
  const examples = finding.examples
    .map(
      (e) => `<li class="mb-3 last:mb-0">
        <blockquote class="rounded-lg border ${quoteBorder} bg-canvas px-3 py-2 text-sm">${esc(e.quote)}</blockquote>
        ${e.note ? `<div class="mt-1 text-xs text-muted">${esc(e.note)}</div>` : ''}
        ${e.at ? `<div class="mt-1 text-xs text-muted">${esc(formatDate(e.at))}</div>` : ''}
        ${player(e)}
      </li>`
    )
    .join('');
  const count = finding.examples.length;
  const details = count
    ? `<details class="disclosure mt-3">
        <summary class="cursor-pointer text-sm text-accent select-none">Переглянути приклади<span class="ml-1.5 rounded-full bg-track px-1.5 py-0.5 text-xs text-muted">${count}</span></summary>
        <ul class="mt-3 list-none p-0">${examples}</ul>
      </details>`
    : '';
  return `<article class="break-avoid mb-3 rounded-xl border border-line p-3">
      <h4 class="flex items-start gap-2 text-[15px] font-semibold">
        <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}"></span>${esc(finding.claim)}
      </h4>
      ${finding.why ? `<p class="mt-1 pl-4 text-sm text-muted">${esc(finding.why)}</p>` : ''}
      ${finding.action ? `<p class="mt-1 pl-4 text-sm">${esc(finding.action)}</p>` : ''}
      ${details}
    </article>`;
}

function findingColumn(title, findings, kind, emptyText) {
  const colour = kind === 'plus' ? 'text-plus' : 'text-minus';
  const body = findings.length
    ? findings.map((f) => findingBlock(f, kind)).join('')
    : `<p class="text-sm text-muted">${esc(emptyText)}</p>`;
  return `<section><h3 class="mb-3 text-[15px] font-semibold ${colour}">${esc(title)}</h3>${body}</section>`;
}

function partialNote(manager) {
  if (!manager.partial || !manager.days) return '';
  return `<p class="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Сильні та слабкі сторони зібрані за ${manager.analysedDays} ${plural(manager.analysedDays, 'день', 'дні', 'днів')} із ${manager.days} — решту проаналізувати поки не вдалося, тож картина може бути неповною.</p>`;
}

function managerCard(manager, months) {
  return `<section class="${CARD}" data-manager-card="${esc(manager.name)}">
      <h2 class="${H2}">${esc(manager.display)}</h2>
      ${tabStrip(withAllLast(months), 'data-month-tab data-month', ALL)}
      ${categoryStrip(manager)}
      ${trendBlock(manager)}
      ${partialNote(manager)}
      <div class="mt-5 grid gap-4 sm:grid-cols-2">
        ${findingColumn('Сильні сторони', manager.strengths, 'plus', 'Стійких сильних патернів за період не набралось.')}
        ${findingColumn('Слабкі місця', manager.weaknesses, 'minus', 'Повторюваних помилок за період не зафіксовано.')}
      </div>
    </section>`;
}


const CMP_METRICS = [
  {
    key: 'conv',
    title: 'Конверсія',
    hint: 'Скільки угод дійшло до запису. Відсоток рахується лише від тих угод, які СТО могло взяти, тож черга й відсутні деталі менеджеру в мінус не йдуть. На кількох угодах відсоток стрибає — тому поруч завжди видно, від скількох він рахувався.',
  },
  {
    key: 'score',
    title: 'Середній бал розмови',
    hint: 'Оцінка того, ЯК менеджер веде діалог: вітання, виявлення потреби, робота із запереченнями, перебивання клієнта й довгі паузи. Шкала — від 1 до 10, ставиться кожній розмові-угоді окремо.',
  },
  {
    key: 'sales',
    title: 'Угод',
    hint: 'Скільки розмов узагалі давали можливість записати клієнта. Це навантаження: у менеджера з трьома угодами і в менеджера з пʼятдесятьма однакові відсотки означають різне.',
  },
];

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
        `<text x="${L - 6}" y="${(py(t) + 3.5).toFixed(1)}" text-anchor="end" class="chart-axis">${esc(String(Math.round(t)) + suffix)}</text>`
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

function compareSection(report) {
  const { managers, months } = report;
  if (managers.length < 2) return '';

  const rows = (metric) =>
    managers
      .map(
        (m, i) => `<div class="mt-3.5 first:mt-0 grid grid-cols-[1fr_auto] items-baseline gap-x-2.5 gap-y-1"
          data-cmp="${esc(metric)}" data-manager="${esc(m.name)}">
          <span class="text-sm font-semibold">${esc(m.display)}</span>
          <span class="text-[17px] font-bold tabular-nums" data-cmp-val></span>
          <span class="col-span-2 h-2.5 overflow-hidden rounded-full bg-track">
            <span class="block h-full w-0 rounded-full transition-[width] duration-300" style="background:${MANAGER_COLORS[i % MANAGER_COLORS.length]}" data-cmp-bar></span>
          </span>
          <span class="col-span-2 text-xs text-muted" data-cmp-sub></span>
        </div>`
      )
      .join('');

  const blocks = CMP_METRICS.map(
    (metric) => `<div class="rounded-xl border border-line p-4">
      <h3 class="mb-3.5 flex items-center justify-between gap-2 text-[15px] font-semibold">${esc(metric.title)}${tip(metric.title, metric.hint)}</h3>
      ${rows(metric.key)}
    </div>`
  ).join('');

  const convPeak = Math.max(
    20,
    ...managers.flatMap((m) => months.map((mo) => (m.byMonth[mo.key] || {}).conversion || 0))
  );
  const convMax = Math.ceil(convPeak / 20) * 20;

  const legendItems = managers
    .map(
      (m, i) =>
        `<li class="flex items-center gap-2"><i class="h-3 w-3 shrink-0 rounded-sm" style="background:${MANAGER_COLORS[i % MANAGER_COLORS.length]}"></i>${esc(m.display)}</li>`
    )
    .join('');

  return `<section class="${CARD}">
    <h2 class="${H2}">Порівняння менеджерів</h2>
    <p class="${LEAD}">Ті самі показники поруч: видно, хто веде, а хто відстає. Порядок менеджерів скрізь однаковий, тож при перемиканні місяця рядки не стрибають. Графіки нижче показують не поточний стан, а рух — чи росте кожен із місяця в місяць.</p>
    ${tabStrip(withAllLast(months), 'data-compare-tab', ALL)}
    <div class="grid gap-3.5">${blocks}</div>
    <h3 class="${H3}">Як змінюється з місяця в місяць</h3>
    <div class="grid gap-4 sm:grid-cols-2">
      ${lineChart(managers, months, 'conversion', { max: convMax, suffix: '%', title: 'Конверсія по місяцях' })}
      ${lineChart(managers, months, 'avgScore', { max: 10, title: 'Середній бал по місяцях' })}
    </div>
    <ul class="mt-3.5 flex list-none flex-wrap gap-4 p-0 text-sm">${legendItems}</ul>
  </section>`;
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

function declineSection(declines) {
  const titles = declines.bucketTitles || declines.bucketLabels || {};
  const buckets = Object.entries(declines.buckets)
    .map(
      ([key, n]) => `<div class="rounded-xl border border-line p-3.5 text-center">
        <div class="text-3xl font-bold">${n}</div>
        <div class="mt-1 text-sm text-muted">${esc(titles[key] || key)}</div>
      </div>`
    )
    .join('');

  const maxReason = Math.max(1, ...declines.reasons.map((r) => r.count));
  const reasons = declines.reasons.length
    ? barList(declines.reasons, { max: maxReason })
    : '<li class="text-sm text-muted">Причини ще не розмічені.</li>';

  const caseMonths = [...new Set(declines.cases.map((c) => monthKey(c.at)).filter(Boolean))]
    .sort()
    .map((key) => ({ key, title: monthTitle(key) }));

  const cases = declines.cases.length
    ? declines.cases
        .map(
          (c) => `<tr class="border-b border-line align-top" data-decline-month="${esc(monthKey(c.at))}">
          <td class="whitespace-nowrap px-1 py-2" data-label="Дата">${esc(formatDateShort(c.at))}</td>
          <td class="px-1 py-2" data-label="Причина">${esc(c.reason || c.bucketLabel || '—')}</td>
          <td class="px-1 py-2" data-label="Клієнт">${esc(c.clientName || 'Невідомо')}<br><span class="text-xs text-muted">${esc(c.clientPhone || '—')}</span></td>
          <td class="px-1 py-2" data-label="Менеджер">${esc(c.manager)}</td>
          <td class="px-1 py-2 text-muted" data-label="Слова менеджера">${esc(c.quote || '')}</td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="px-1 py-2 text-sm text-muted">Жодного випадку не зафіксовано.</td></tr>';

  const cov = declines.coverage || {};
  const notBooked = cov.notBooked ?? 0;
  return `<section class="${CARD}">
      <h2 class="${H2}">Найбільш поширені причини відмов від обслуговування</h2>
      <p class="${LEAD}">За період не закрилося ${notBooked} ${plural(notBooked, 'угода', 'угоди', 'угод')}. Частину з них СТО взяти не могло — не було вільного місця, потрібної деталі або такої послуги взагалі. В решті випадків сервіс міг виконати роботу, але клієнт вирішив інакше.</p>
      <h3 class="${H3}">Причини відмов</h3>
      <div class="grid gap-3 sm:grid-cols-3">${buckets}</div>
      <h3 class="${H3}">Часті причини</h3>
      <ul class="list-none p-0">${reasons}</ul>
      <h3 class="${H3}">Кому відмовили — можна передзвонити</h3>
      ${caseMonths.length ? tabStrip(withAllLast(caseMonths), 'data-decline-tab', ALL) : ''}
      <table class="cards-on-mobile w-full table-fixed border-collapse text-sm">
        <colgroup><col class="w-20"><col class="w-48"><col class="w-44"><col class="w-28"><col></colgroup>
        <thead class="text-left text-muted">
          <tr class="border-b border-line">
            <th class="px-1 py-2 font-semibold">Дата</th><th class="px-1 py-2 font-semibold">Причина</th>
            <th class="px-1 py-2 font-semibold">Клієнт</th><th class="px-1 py-2 font-semibold">Менеджер</th>
            <th class="px-1 py-2 font-semibold">Слова менеджера</th>
          </tr>
        </thead>
        <tbody>${cases}</tbody>
      </table>
      <p class="mt-3 text-sm text-muted">У цю таблицю потрапляють лише ті, кого в результаті <b>не записали</b>. Якщо клієнта записали на іншу дату — угода вважається закритою, і в таблиці його немає.</p>
    </section>`;
}

function stagesSection(stages) {
  if (!stages.length) return '';
  const max = Math.max(...stages.map((s) => s.count));
  const items = barList(stages.map((s) => ({ label: s.stage, count: s.count, side: 'service' })), { max });
  return `<section class="${CARD}">
      <h2 class="${H2}">Над чим варто попрацювати</h2>
      <p class="${LEAD}">Найслабший етап розмови, визначений для кожної угоди окремо.</p>
      <ul class="list-none p-0">${items}</ul>
    </section>`;
}

function methodSection(report) {
  const d = report.declines.coverage || {};
  return `<section class="${CARD}">
      <h2 class="${H2}">Як це рахується</h2>
      <ul class="list-disc space-y-2 pl-5 text-sm">
        <li><b>Конверсія</b> — записи поділені на угоди, з яких прибрані ті, що СТО не могло взяти. Менеджера не оцінюють за роботу, якої сервіс не міг прийняти.</li>
        <li><b>Відмов СТО — ${report.declines.serviceTotal}, а незакритих угод — ${d.notBooked ?? 0}</b>, і ці числа не мусять збігатися. Коли менеджер одразу каже «таким не займаємось», система визначає такий дзвінок як звернення без можливості запису, а не як угоду. Проте у таблицю відмов такі дзвінки все одно заносяться: це втрачений клієнт незалежно від причини відмови.</li>
        <li><b>Приклади діалогів</b> не переказані. Кожен — дослівний рядок із розмови, знайдений у записі повторно вже кодом; те, що не знайшлося, у звіт не потрапляє.</li>
        <li><b>Аудіо під прикладом</b> — вирізка з того самого запису навколо процитованого рядка, з кількома секундами контексту з обох боків. Якщо запис не зберігся або цитата не має таймкоду, лишається тільки текст.</li>
        <li><b>Сильні та слабкі сторони</b> рахуються за весь період, а не за місяць: умови розрахунків потребують щонайменше двох прикладів.</li>
        <li>У звіт потрапляють лише дзвінки, у яких справді відбулася розмова. Кілька секундних зʼєднань без мови до підрахунків не входять.</li>
      </ul>
    </section>`;
}


function renderGlobalReport(report) {
  const { totals, months, managers, declines } = report;
  const days = Math.round(totals.hours / WORK_DAY_HOURS);

  const managerTabs = managers
    .map(
      (m, i) =>
        `<button type="button" class="rounded-full border border-line bg-card px-4 py-2 text-[15px] font-semibold cursor-pointer transition hover:border-muted aria-selected:bg-ink aria-selected:border-ink aria-selected:text-white" data-manager-tab="${esc(m.name)}" aria-selected="${i === 0}">${esc(m.display)}</button>`
    )
    .join('');

  const data = {
    managers: Object.fromEntries(managers.map((m) => [m.name, m.byMonth])),
    lines: Object.fromEntries((report.lines || []).map((l) => [l.number, l.byMonth])),
    lineManagers: Object.fromEntries(
      (report.lines || [])
        .filter((l) => l.managers?.length)
        .map((l) => [l.number, Object.fromEntries(l.managers.map((m) => [m.name, m.byMonth]))])
    ),
    intro: Object.fromEntries((report.intro?.managers || []).map((m) => [m.name, m.byMonth])),
    series: report.series || {},
  };

  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Аналітика дзвінків</title>
<link rel="stylesheet" href="assets/app.css">
</head>
<body class="font-sans text-base leading-relaxed">
<div class="mx-auto max-w-7xl p-3 sm:p-4">
  <header class="${CARD} flex flex-col gap-6 md:flex-row md:items-center md:gap-10">
    <div class="shrink-0">
      <h1 class="text-2xl sm:text-3xl font-bold leading-tight">Аналітика дзвінків</h1>
      <p class="mt-3 leading-snug text-muted">${esc(periodSpan(report.period.start, report.period.end))} <br> ${totals.managers} ${esc(plural(totals.managers, 'менеджер', 'менеджери', 'менеджерів'))}</p>
    </div>
    <div class="flex flex-wrap items-center gap-5 md:border-l md:border-line md:pl-10">
      <div class="shrink-0">
        <div class="text-4xl font-bold leading-none tabular-nums sm:text-5xl">${totals.hours}</div>
        <div class="mt-1 text-muted">${esc(plural(Math.round(totals.hours), 'година', 'години', 'годин'))} розмов</div>
      </div>
      <p class="m-0 min-w-0 flex-1 basis-80 text-muted">
        <b class="text-ink">${totals.calls} ${esc(plural(totals.calls, 'розмова', 'розмови', 'розмов'))} — автоматично розшифровано та проаналізовано.</b>
        <br>
        Щоб прослухати та опрацювати такий обсяг дзвінків вручну, знадобилося б приблизно <b class="text-ink">${days} ${esc(plural(days, 'робочий день', 'робочі дні', 'робочих днів'))} безперервного прослуховування.</b>
        <br>
        Усі ${totals.calls} ${esc(plural(totals.calls, 'розмову', 'розмови', 'розмов'))} було автоматично розшифровано, структуровано та проаналізовано, що дозволило отримати повну картину зафіксованих комунікацій без необхідності прослуховувати кожен дзвінок вручну.
      </p>
    </div>
  </header>

  <section class="${CARD}">
    <h2 class="${H2}">Категорії дзвінків</h2>
    <div class="flex flex-wrap items-center gap-6">
      ${donut(totals.purposes, totals.calls)}
      ${categoryTable(totals.purposes, report.directions || {}, totals.calls)}
    </div>
    ${linesSection(report)}
  </section>

  ${introSection(report)}

  <div class="mb-3 flex flex-wrap gap-2 no-print" role="tablist">${managerTabs}</div>

  ${managers.map((m) => managerCard(m, months)).join('')}

  ${compareSection(report)}
  ${declineSection(declines)}
  ${stagesSection(report.stages)}
  ${methodSection(report)}

  <footer class="px-0 pb-6 pt-2 text-center text-xs text-muted">Сформовано ${esc(formatDate(report.generatedAt))}</footer>
</div>
<script type="application/json" id="report-data">${json(data)}</script>
<script src="assets/app.js" defer></script>
</body>
</html>`;
}

export { renderGlobalReport };
