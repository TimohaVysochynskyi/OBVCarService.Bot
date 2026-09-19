import { PURPOSE_LABELS } from '../core/callPurpose.js';
import { ALL } from './globalReportData.js';

const PURPOSE_ORDER = ['sales', 'info', 'other', 'personal'];
const PURPOSE_COLORS = { sales: '#2f7d58', info: '#3b6fb0', other: '#8a7a3f', personal: '#8c5aa8' };
const WORK_DAY_HOURS = 8;

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function donut(purposes, total) {
  if (!total) return '';
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = PURPOSE_ORDER.filter((p) => purposes[p]).map((p) => {
    const share = purposes[p] / total;
    const length = share * circumference;
    const arc = `<circle class="arc" r="${radius}" cx="70" cy="70" fill="none" stroke="${PURPOSE_COLORS[p]}" stroke-width="22" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
    offset += length;
    return arc;
  });
  return `<svg viewBox="0 0 140 140" class="donut" role="img" aria-label="Розподіл дзвінків за категоріями">
      <g transform="rotate(-90 70 70)">${arcs.join('')}</g>
      <text x="70" y="66" class="donut-num">${total}</text>
      <text x="70" y="84" class="donut-cap">дзвінків</text>
    </svg>`;
}

function barChart(series, { max, months, suffix = '', decimals = 0 }) {
  if (!months.length) return '';
  const width = 100 / months.length;
  const bars = months
    .map((m, i) => {
      const value = series[m.key];
      const height = value == null || !max ? 0 : Math.max(2, (value / max) * 100);
      const label = value == null ? '—' : value.toFixed(decimals) + suffix;
      return `<div class="bar-slot" data-month="${esc(m.key)}" style="width:${width}%">
          <div class="bar-val">${esc(label)}</div>
          <div class="bar" style="height:${height.toFixed(1)}%"></div>
          <div class="bar-cap">${esc(m.title.split(' ')[0].slice(0, 3))}</div>
        </div>`;
    })
    .join('');
  return `<div class="chart">${bars}</div>`;
}

function managerTable(manager, months) {
  const head = months.map((m) => `<th data-month="${esc(m.key)}">${esc(m.title.split(' ')[0])}</th>`).join('');
  const row = (label, pick) =>
    `<tr><th scope="row">${esc(label)}</th>${months
      .map((m) => `<td data-month="${esc(m.key)}">${esc(pick(manager.byMonth[m.key] || {}))}</td>`)
      .join('')}<td class="total">${esc(pick(manager.byMonth[ALL] || {}))}</td></tr>`;

  return `<table class="grid">
      <thead><tr><th scope="col"></th>${head}<th scope="col" class="total">Разом</th></tr></thead>
      <tbody>
        ${row('Угод', (b) => b.sales ?? 0)}
        ${row('Записів', (b) => b.success ?? 0)}
        ${row('Конверсія', (b) => (b.conversion == null ? '—' : b.conversion + '%'))}
        ${row('Середній бал', (b) => (b.avgScore == null ? '—' : b.avgScore))}
      </tbody>
    </table>`;
}

function categoryStrip(manager) {
  return `<div class="cats">
      ${PURPOSE_ORDER.map(
        (p) => `<div class="cat" style="--c:${PURPOSE_COLORS[p]}">
          <span class="cat-icon">${PURPOSE_LABELS[p].icon}</span>
          <span class="cat-num" data-cat="${p}">0</span>
          <span class="cat-name">${esc(PURPOSE_LABELS[p].plural)}</span>
        </div>`
      ).join('')}
    </div>`;
}

function findingBlock(finding, kind) {
  const examples = finding.examples
    .map(
      (e) => `<li>
        <blockquote>${esc(e.quote)}</blockquote>
        ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
        ${e.at ? `<div class="when">${esc(formatDate(e.at))}</div>` : ''}
      </li>`
    )
    .join('');
  return `<article class="finding ${kind}">
      <h4>${esc(finding.claim)}</h4>
      ${finding.why ? `<p class="why">${esc(finding.why)}</p>` : ''}
      ${finding.action ? `<p class="action">${esc(finding.action)}</p>` : ''}
      <ul class="examples">${examples}</ul>
    </article>`;
}

function findingColumn(title, findings, kind, emptyText) {
  const body = findings.length
    ? findings.map((f) => findingBlock(f, kind)).join('')
    : `<p class="empty">${esc(emptyText)}</p>`;
  return `<section class="col ${kind}"><h3>${esc(title)}</h3>${body}</section>`;
}

function managerCard(manager, months) {
  const convSeries = Object.fromEntries(months.map((m) => [m.key, manager.byMonth[m.key]?.conversion ?? null]));
  const scoreSeries = Object.fromEntries(months.map((m) => [m.key, manager.byMonth[m.key]?.avgScore ?? null]));

  return `<section class="card manager" data-manager="${esc(manager.name)}">
      <h2>${esc(manager.display)}</h2>
      ${categoryStrip(manager)}
      <h3 class="sub">Динаміка по угодах</h3>
      ${managerTable(manager, months)}
      <div class="charts">
        <figure><figcaption>Конверсія, %</figcaption>${barChart(convSeries, { max: 100, months, suffix: '%' })}</figure>
        <figure><figcaption>Середній бал</figcaption>${barChart(scoreSeries, { max: 10, months, decimals: 1 })}</figure>
      </div>
      <div class="cols">
        ${findingColumn('Сильні сторони', manager.strengths, 'plus', 'Стійких сильних патернів за період не набралось.')}
        ${findingColumn('Слабкі місця', manager.weaknesses, 'minus', 'Повторюваних помилок за період не зафіксовано.')}
      </div>
    </section>`;
}

function declineSection(declines) {
  const buckets = Object.entries(declines.buckets)
    .map(
      ([key, n]) => `<div class="bucket">
        <div class="bucket-num">${n}</div>
        <div class="bucket-name">${esc(declines.bucketLabels[key] || key)}</div>
      </div>`
    )
    .join('');

  const maxReason = Math.max(1, ...declines.reasons.map((r) => r.count));
  const reasons = declines.reasons.length
    ? declines.reasons
        .map(
          (r) => `<li class="${r.side}">
          <span class="reason-name">${esc(r.label)}</span>
          <span class="reason-bar"><i style="width:${((r.count / maxReason) * 100).toFixed(1)}%"></i></span>
          <span class="reason-num">${r.count}</span>
        </li>`
        )
        .join('')
    : '<li class="empty">Причини ще не розмічені.</li>';

  const cases = declines.cases.length
    ? declines.cases
        .map(
          (c) => `<tr>
          <td>${esc(formatDate(c.at))}</td>
          <td>${esc(c.bucketLabel)}</td>
          <td>${esc(c.reason || '—')}</td>
          <td>${esc(c.clientName || 'Невідомо')}<br><span class="phone">${esc(c.clientPhone || '—')}</span></td>
          <td>${esc(c.manager)}</td>
          <td class="quote">${esc(c.quote || '')}</td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty">Жодного випадку не зафіксовано.</td></tr>';

  const cov = declines.coverage || {};
  return `<section class="card">
      <h2>Чому клієнт не записався</h2>
      <p class="lead">Незакритих угод за період — <b>${cov.notBooked ?? 0}</b>. Нижче вони поділені на дві різні речі: коли СТО не могло взяти роботу, і коли клієнт вирішив інакше.</p>
      <h3 class="sub">Не змогли взяти</h3>
      <div class="buckets">${buckets}</div>
      <h3 class="sub">Часті причини</h3>
      <ul class="reasons">${reasons}</ul>
      <h3 class="sub">Кому відмовили — можна передзвонити</h3>
      <div class="scroll">
        <table class="grid cases">
          <thead><tr><th>Дата</th><th>Категорія</th><th>Причина</th><th>Клієнт</th><th>Менеджер</th><th>Слова менеджера</th></tr></thead>
          <tbody>${cases}</tbody>
        </table>
      </div>
      <p class="fine">У цю таблицю потрапляють лише ті, кого в результаті <b>не записали</b>. Якщо клієнта записали на іншу дату — угода вважається закритою, і в таблиці його немає.</p>
    </section>`;
}

function stagesSection(stages) {
  if (!stages.length) return '';
  const max = Math.max(...stages.map((s) => s.count));
  const items = stages
    .map(
      (s) => `<li>
        <span class="reason-name">${esc(s.stage)}</span>
        <span class="reason-bar"><i style="width:${((s.count / max) * 100).toFixed(1)}%"></i></span>
        <span class="reason-num">${s.count}</span>
      </li>`
    )
    .join('');
  return `<section class="card">
      <h2>Де втрачаються угоди</h2>
      <p class="lead">Найслабший етап розмови, визначений для кожної угоди окремо.</p>
      <ul class="reasons">${items}</ul>
    </section>`;
}

function methodSection(report) {
  const d = report.declines.coverage || {};
  return `<section class="card method">
      <h2>Як це рахується</h2>
      <ul>
        <li><b>Конверсія</b> — записи поділені на угоди, з яких прибрані ті, що СТО не могло взяти. Менеджера не оцінюють за роботу, якої сервіс не міг прийняти.</li>
        <li><b>Відмов СТО — ${report.declines.serviceTotal}, а незакритих угод — ${d.notBooked ?? 0}</b>, і ці числа не мусять збігатися. Коли менеджер одразу каже «таким не займаємось», система бачить довідку, а не угоду. У таблицю відмов такі дзвінки все одно входять: це втрачений клієнт незалежно від того, як розмову позначили.</li>
        <li><b>Цитати</b> не переказані. Кожна — дослівний рядок із розмови, знайдений у записі повторно вже кодом; те, що не знайшлося, у звіт не потрапляє.</li>
        <li><b>Сильні та слабкі сторони</b> рахуються за весь період, а не за місяць: патерн вимагає щонайменше двох прикладів, а в окремі місяці угод надто мало.</li>
        <li>У звіт увійшли дзвінки з розшифровкою. Кілька секундних дзвінків без мови до підрахунків не входять.</li>
      </ul>
    </section>`;
}

function renderGlobalReport(report) {
  const { totals, months, managers, declines } = report;
  const days = Math.round(totals.hours / WORK_DAY_HOURS);
  const monthButtons = [{ key: ALL, title: 'Весь період' }, ...months]
    .map(
      (m, i) =>
        `<button type="button" class="tab${i === 0 ? ' on' : ''}" data-month="${esc(m.key)}">${esc(m.title)}</button>`
    )
    .join('');

  const legend = PURPOSE_ORDER.map(
    (p) => `<li><i style="background:${PURPOSE_COLORS[p]}"></i>${esc(PURPOSE_LABELS[p].plural)} — <b>${totals.purposes[p] || 0}</b></li>`
  ).join('');

  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Звіт по дзвінках</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #fff; --ink: #1d2126; --muted: #667085; --line: #e4e7ec;
    --plus: #2f7d58; --minus: #b4453a; --accent: #1d4ed8;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 20px; margin: 0 0 12px; }
  h3.sub { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 22px 0 10px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px; margin: 0 0 16px; }
  .lead { color: var(--muted); margin: 0 0 14px; }
  .hero { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
  .hero .big { font-size: 44px; font-weight: 700; line-height: 1; }
  .hero .cap { color: var(--muted); }
  .mix { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; }
  .donut { width: 140px; height: 140px; flex: none; }
  .donut-num { text-anchor: middle; font-size: 26px; font-weight: 700; fill: var(--ink); }
  .donut-cap { text-anchor: middle; font-size: 11px; fill: var(--muted); }
  .legend { list-style: none; margin: 0; padding: 0; }
  .legend li { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .tabs { display: flex; gap: 8px; flex-wrap: wrap; position: sticky; top: 0; z-index: 5;
    background: var(--bg); padding: 10px 0; margin-bottom: 8px; }
  .tab { border: 1px solid var(--line); background: var(--card); color: var(--ink);
    border-radius: 999px; padding: 7px 14px; font-size: 14px; cursor: pointer; }
  .tab.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .cats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 4px 0 8px; }
  .cat { border: 1px solid var(--line); border-left: 4px solid var(--c); border-radius: 10px;
    padding: 10px 8px; text-align: center; }
  .cat-icon { display: block; font-size: 15px; }
  .cat-num { display: block; font-size: 22px; font-weight: 700; }
  .cat-name { display: block; font-size: 12px; color: var(--muted); }
  table.grid { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.grid th, table.grid td { border-bottom: 1px solid var(--line); padding: 8px 6px; text-align: right; }
  table.grid th[scope="row"], table.grid thead th:first-child { text-align: left; }
  table.grid thead th { color: var(--muted); font-weight: 600; }
  .total { font-weight: 700; }
  td.sel, th.sel { background: #eef4ff; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
  figure { margin: 0; }
  figcaption { font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  .chart { display: flex; align-items: flex-end; height: 120px; gap: 4px; }
  .bar-slot { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; text-align: center; }
  .bar { background: #c9d6ef; border-radius: 4px 4px 0 0; }
  .bar-slot.sel .bar { background: var(--accent); }
  .bar-val { font-size: 11px; color: var(--muted); }
  .bar-cap { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; }
  .col h3 { font-size: 15px; margin: 0 0 10px; }
  .col.plus h3 { color: var(--plus); }
  .col.minus h3 { color: var(--minus); }
  .finding { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .finding.plus { border-left: 4px solid var(--plus); }
  .finding.minus { border-left: 4px solid var(--minus); }
  .finding h4 { margin: 0 0 6px; font-size: 15px; }
  .why, .action { margin: 0 0 6px; font-size: 14px; color: var(--muted); }
  .examples { list-style: none; margin: 8px 0 0; padding: 0; }
  .examples li { margin-bottom: 8px; }
  blockquote { margin: 0; padding: 6px 10px; background: #f7f8fa; border-left: 3px solid var(--line);
    border-radius: 0 6px 6px 0; font-size: 14px; }
  .note { font-size: 12px; color: var(--muted); padding: 2px 10px; }
  .when { font-size: 11px; color: var(--muted); padding: 0 10px; }
  .empty { color: var(--muted); font-size: 14px; }
  .buckets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .bucket { border: 1px solid var(--line); border-radius: 10px; padding: 14px; text-align: center; }
  .bucket-num { font-size: 30px; font-weight: 700; }
  .bucket-name { color: var(--muted); font-size: 13px; }
  ul.reasons { list-style: none; margin: 0; padding: 0; }
  ul.reasons li { display: grid; grid-template-columns: minmax(120px, 1fr) 2fr 44px;
    gap: 10px; align-items: center; padding: 5px 0; font-size: 14px; }
  .reason-bar { background: #eef0f4; border-radius: 999px; height: 10px; overflow: hidden; }
  .reason-bar i { display: block; height: 100%; background: #9db4dd; }
  li.service .reason-bar i { background: #d79a93; }
  .reason-num { text-align: right; font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; }
  table.cases td { text-align: left; vertical-align: top; font-size: 13px; }
  table.cases .quote { color: var(--muted); max-width: 320px; }
  .phone { color: var(--muted); font-size: 12px; }
  .fine { font-size: 13px; color: var(--muted); margin-top: 12px; }
  .method ul { margin: 0; padding-left: 18px; }
  .method li { margin-bottom: 8px; font-size: 14px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; padding: 8px 0 24px; }
  @media (max-width: 720px) {
    .cols, .charts, .buckets { grid-template-columns: 1fr; }
    .cats { grid-template-columns: repeat(2, 1fr); }
    h1 { font-size: 22px; }
    .hero .big { font-size: 36px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="card">
    <h1>Звіт по дзвінках</h1>
    <p class="lead">${esc(formatDate(report.period.start))} — ${esc(formatDate(report.period.end))} · ${totals.managers} ${esc(plural(totals.managers, 'менеджер', 'менеджери', 'менеджерів'))}</p>
    <div class="hero">
      <div>
        <div class="big">${totals.hours}</div>
        <div class="cap">${esc(plural(Math.round(totals.hours), 'година', 'години', 'годин'))} розмов</div>
      </div>
      <p class="lead" style="flex:1 1 320px;margin:0">Стільки часу довелося б прослухати вручну, щоб знати все, що є в цьому звіті — приблизно ${days} ${esc(plural(days, 'робочий день', 'робочі дні', 'робочих днів'))} суцільного прослуховування. Усі ${totals.calls} розмов розшифровано й розібрано автоматично.</p>
    </div>
  </header>

  <section class="card">
    <h2>На що йде телефонна лінія</h2>
    <div class="mix">
      ${donut(totals.purposes, totals.calls)}
      <ul class="legend">${legend}</ul>
    </div>
  </section>

  <div class="tabs">${monthButtons}</div>

  ${managers.map((m) => managerCard(m, months)).join('')}

  ${declineSection(declines)}
  ${stagesSection(report.stages)}
  ${methodSection(report)}

  <footer>Сформовано ${esc(formatDate(report.generatedAt))}</footer>
</div>
<script>
(function () {
  var DATA = ${json(Object.fromEntries(managers.map((m) => [m.name, m.byMonth])))};
  var ALL = ${json(ALL)};
  var tabs = document.querySelectorAll('.tab');
  var cats = ['sales', 'info', 'other', 'personal'];

  function apply(month) {
    document.querySelectorAll('.manager').forEach(function (card) {
      var bucket = (DATA[card.dataset.manager] || {})[month] || {};
      cats.forEach(function (c) {
        var el = card.querySelector('[data-cat="' + c + '"]');
        if (el) el.textContent = bucket[c] || 0;
      });
      card.querySelectorAll('[data-month]').forEach(function (el) {
        el.classList.toggle('sel', month !== ALL && el.dataset.month === month);
      });
    });
    tabs.forEach(function (t) { t.classList.toggle('on', t.dataset.month === month); });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { apply(t.dataset.month); });
  });

  apply(ALL);
})();
</script>
</body>
</html>`;
}

export { renderGlobalReport };
