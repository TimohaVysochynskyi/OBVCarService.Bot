import { ALL } from '../globalReportData.js';
import { PURPOSE_LABELS } from '../../../domain/call/purpose.js';
import { esc, formatDate, plural, share } from './format.js';
import { CARD, H2, H3, PURPOSE_COLORS, PURPOSE_ORDER } from './tokens.js';
import { player, tabStrip, tip, withAllLast } from './widgets.js';

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

export {
  SERIES,
  categoryStrip,
  findingBlock,
  findingColumn,
  managerCard,
  partialNote,
  trendBlock,
};
