import { PURPOSE_LABELS } from '../core/callPurpose.js';
import { ALL } from './globalReportData.js';

// Renders the report's index.html. Styles and behaviour are NOT inlined any more — they are
// assets/app.css (built from tailwind/input.css) and assets/app.js, shipped beside this page by
// globalReportBundle.js. The page therefore only works as part of its folder, which is exactly how
// it is delivered: a zip now, a subdomain later.

const PURPOSE_ORDER = ['sales', 'info', 'other', 'personal'];
const PURPOSE_COLORS = { sales: '#2f7d58', info: '#3b6fb0', other: '#8a7a3f', personal: '#8c5aa8' };
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

const clock = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
};

// --- shared pieces ---------------------------------------------------------------------------

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
  // Opening the popover fills the circle and turns the "i" white — the client asked for exactly
  // that, and it is the only sign of WHICH badge is open. It styles a child by the PARENT's [open]
  // state, which utilities cannot express, so the rule lives in the components layer.
  return `<details data-tip class="relative ml-auto shrink-0 no-print">
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

function barChart(series, { max, months, suffix = '', decimals = 0 }) {
  if (!months.length) return '';
  const bars = months
    .map((m) => {
      const value = series[m.key];
      const height = value == null || !max ? 0 : Math.max(2, (value / max) * 100);
      const label = value == null ? '—' : value.toFixed(decimals) + suffix;
      return `<div class="flex flex-1 flex-col justify-end text-center" data-month="${esc(m.key)}">
          <div class="text-[11px] text-muted">${esc(label)}</div>
          <div class="rounded-t bg-[#c9d6ef]" style="height:${height.toFixed(1)}%"></div>
          <div class="mt-1 text-[11px] text-muted">${esc(shortMonth(m.title))}</div>
        </div>`;
    })
    .join('');
  return `<div class="flex h-32 items-end gap-1">${bars}</div>`;
}

// --- audio evidence --------------------------------------------------------------------------

// A clip is attached only when the quote had a timecode AND the cut succeeded, so the player never
// appears over silence. Without one the quote still stands on its own — it is the evidence; the
// audio is a convenience for checking it.
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

// --- manager card ----------------------------------------------------------------------------

function categoryStrip(manager) {
  const total = manager.byMonth[ALL] || {};
  const cells = PURPOSE_ORDER.map(
    (p) => `<div class="relative rounded-xl border border-line border-l-4 p-2.5 text-center" style="border-left-color:${PURPOSE_COLORS[p]}">
        <div class="flex">${tip(PURPOSE_LABELS[p].plural, PURPOSE_LABELS[p].about)}</div>
        <span class="block text-[15px]">${PURPOSE_LABELS[p].icon}</span>
        <span class="block text-xl font-bold" data-cat="${p}">${total[p] || 0}</span>
        <span class="block text-xs text-muted">${esc(PURPOSE_LABELS[p].plural)}</span>
      </div>`
  ).join('');
  return `<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">${cells}</div>`;
}

function managerTable(manager, months) {
  const head = months
    .map(
      (m) =>
        `<th class="px-1 py-2 text-right font-semibold" data-month="${esc(m.key)}"><span class="hidden sm:inline">${esc(m.title.split(' ')[0])}</span><span class="sm:hidden">${esc(shortMonth(m.title))}</span></th>`
    )
    .join('');
  const row = (label, pick) =>
    `<tr class="border-b border-line">
      <th scope="row" class="px-1 py-2 text-left font-normal text-muted">${esc(label)}</th>
      ${months.map((m) => `<td class="px-1 py-2 text-right tabular-nums" data-month="${esc(m.key)}">${esc(pick(manager.byMonth[m.key] || {}))}</td>`).join('')}
      <td class="px-1 py-2 text-right font-bold tabular-nums">${esc(pick(manager.byMonth[ALL] || {}))}</td>
    </tr>`;

  return `<table class="w-full border-collapse text-sm">
      <thead class="text-muted"><tr class="border-b border-line"><th></th>${head}<th class="px-1 py-2 text-right font-semibold">Разом</th></tr></thead>
      <tbody>
        ${row('Угод', (b) => b.sales ?? 0)}
        ${row('Записів', (b) => b.success ?? 0)}
        ${row('Конверсія', (b) => (b.conversion == null ? '—' : b.conversion + '%'))}
        ${row('Бал', (b) => (b.avgScore == null ? '—' : b.avgScore))}
      </tbody>
    </table>`;
}

function findingBlock(finding, kind) {
  const accent = kind === 'plus' ? 'border-l-plus' : 'border-l-minus';
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
  return `<article class="break-avoid mb-3 rounded-xl border border-line border-l-4 ${accent} p-3">
      <h4 class="text-[15px] font-semibold">${esc(finding.claim)}</h4>
      ${finding.why ? `<p class="mt-1 text-sm text-muted">${esc(finding.why)}</p>` : ''}
      ${finding.action ? `<p class="mt-1 text-sm">${esc(finding.action)}</p>` : ''}
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
  const convSeries = Object.fromEntries(months.map((m) => [m.key, manager.byMonth[m.key]?.conversion ?? null]));
  const scoreSeries = Object.fromEntries(months.map((m) => [m.key, manager.byMonth[m.key]?.avgScore ?? null]));

  return `<section class="${CARD}" data-manager-card="${esc(manager.name)}">
      <h2 class="${H2}">${esc(manager.display)}</h2>
      ${tabStrip(withAllLast(months), 'data-month-tab data-month', ALL)}
      ${categoryStrip(manager)}
      <h3 class="${H3}">Динаміка по угодах</h3>
      ${managerTable(manager, months)}
      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <figure class="m-0"><figcaption class="mb-1.5 text-sm text-muted">Конверсія, %</figcaption>${barChart(convSeries, { max: 100, months, suffix: '%' })}</figure>
        <figure class="m-0"><figcaption class="mb-1.5 text-sm text-muted">Середній бал</figcaption>${barChart(scoreSeries, { max: 10, months, decimals: 1 })}</figure>
      </div>
      ${partialNote(manager)}
      <div class="mt-5 grid gap-4 sm:grid-cols-2">
        ${findingColumn('Сильні сторони', manager.strengths, 'plus', 'Стійких сильних патернів за період не набралось.')}
        ${findingColumn('Слабкі місця', manager.weaknesses, 'minus', 'Повторюваних помилок за період не зафіксовано.')}
      </div>
    </section>`;
}

// --- comparison ------------------------------------------------------------------------------

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

  const grid = [0, max / 2, max]
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
      <h3 class="mb-3.5 flex items-center gap-2 text-[15px] font-semibold">${esc(metric.title)}${tip(metric.title, metric.hint)}</h3>
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

// --- refusals --------------------------------------------------------------------------------

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

// --- page ------------------------------------------------------------------------------------

function renderGlobalReport(report) {
  const { totals, months, managers, declines } = report;
  const days = Math.round(totals.hours / WORK_DAY_HOURS);

  const managerTabs = managers
    .map(
      (m, i) =>
        `<button type="button" class="rounded-full border border-line bg-card px-4 py-2 text-[15px] font-semibold cursor-pointer transition hover:border-muted aria-selected:bg-ink aria-selected:border-ink aria-selected:text-white" data-manager-tab="${esc(m.name)}" aria-selected="${i === 0}">${esc(m.display)}</button>`
    )
    .join('');

  const legend = PURPOSE_ORDER.map(
    (p) =>
      `<li class="flex items-center gap-2 py-0.5"><i class="h-3 w-3 shrink-0 rounded-sm" style="background:${PURPOSE_COLORS[p]}"></i>${esc(PURPOSE_LABELS[p].plural)} — <b>${totals.purposes[p] || 0}</b> <span class="text-muted">(${share(totals.purposes[p] || 0, totals.calls)})</span></li>`
  ).join('');

  const data = { managers: Object.fromEntries(managers.map((m) => [m.name, m.byMonth])) };

  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Звіт по дзвінках</title>
<link rel="stylesheet" href="assets/app.css">
</head>
<body class="font-sans text-base leading-relaxed">
<div class="mx-auto max-w-5xl p-3 sm:p-4">
  <header class="${CARD}">
    <h1 class="text-2xl sm:text-3xl font-bold">Звіт по дзвінках</h1>
    <p class="${LEAD}">${esc(formatDate(report.period.start))} — ${esc(formatDate(report.period.end))} · ${totals.managers} ${esc(plural(totals.managers, 'менеджер', 'менеджери', 'менеджерів'))}</p>
    <div class="flex flex-wrap items-center gap-5">
      <div>
        <div class="text-5xl font-bold leading-none">${totals.hours}</div>
        <div class="text-muted">${esc(plural(Math.round(totals.hours), 'година', 'години', 'годин'))} розмов</div>
      </div>
      <p class="m-0 flex-1 basis-80 text-muted">Стільки часу довелося б прослухати вручну, щоб знати все, що є в цьому звіті — приблизно ${days} ${esc(plural(days, 'робочий день', 'робочі дні', 'робочих днів'))} суцільного прослуховування. Усі ${totals.calls} ${esc(plural(totals.calls, 'розмову', 'розмови', 'розмов'))} розшифровано й розібрано автоматично.</p>
    </div>
  </header>

  <section class="${CARD}">
    <h2 class="${H2}">Структура дзвінків</h2>
    <div class="flex flex-wrap items-center gap-6">
      ${donut(totals.purposes, totals.calls)}
      <ul class="list-none p-0">${legend}</ul>
    </div>
  </section>

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
