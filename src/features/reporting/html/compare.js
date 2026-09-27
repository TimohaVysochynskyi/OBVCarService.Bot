import { ALL } from '../globalReportData.js';
import { esc } from './format.js';
import { CARD, H2, H3, LEAD, MANAGER_COLORS } from './tokens.js';
import { lineChart, tabStrip, tip, withAllLast } from './widgets.js';

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

export {
  compareSection,
};
