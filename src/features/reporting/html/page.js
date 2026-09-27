import { categoryTable } from './categories.js';
import { compareSection } from './compare.js';
import { declineSection } from './declines.js';
import { esc, formatDate, json, periodSpan, plural } from './format.js';
import { introSection } from './intro.js';
import { linesSection } from './lines.js';
import { managerCard } from './manager.js';
import { methodSection } from './method.js';
import { stagesSection } from './stages.js';
import { CARD, H2, WORK_DAY_HOURS } from './tokens.js';
import { donut } from './widgets.js';

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

export {
  renderGlobalReport,
};
