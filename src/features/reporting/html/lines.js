import { ALL } from '../globalReportData.js';
import { formatLinePhone } from '../../operators/display.js';
import { LINE_KINDS } from '../../../domain/call/phoneLines.js';
import { esc } from './format.js';
import { H2, IN_COLOR, LEAD, OUT_COLOR } from './tokens.js';
import { arrow, tabStrip, tip, withAllLast } from './widgets.js';

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

export {
  linesSection,
};
