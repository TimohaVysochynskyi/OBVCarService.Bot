import { PURPOSE_LABELS } from '../core/callPurpose.js';
import { ALL } from './globalReportData.js';

const PURPOSE_ORDER = ['sales', 'info', 'other', 'personal'];
const PURPOSE_COLORS = { sales: '#2f7d58', info: '#3b6fb0', other: '#8a7a3f', personal: '#8c5aa8' };
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
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${pad2(d.getFullYear() % 100)}`;
}

function monthKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
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
  return `<svg viewBox="0 0 140 140" class="donut" role="img" aria-label="Структура дзвінків">
      <g transform="rotate(-90 70 70)">${arcs.join('')}</g>
      <text x="70" y="66" class="donut-num">${total}</text>
      <text x="70" y="84" class="donut-cap">дзвінків</text>
    </svg>`;
}

function barChart(series, { max, months, suffix = '', decimals = 0 }) {
  if (!months.length) return '';
  const width = 100 / months.length;
  const bars = months
    .map((m) => {
      const value = series[m.key];
      const height = value == null || !max ? 0 : Math.max(2, (value / max) * 100);
      const label = value == null ? '—' : value.toFixed(decimals) + suffix;
      return `<div class="bar-slot" data-month="${esc(m.key)}" style="width:${width}%">
          <div class="bar-val">${esc(label)}</div>
          <div class="bar" style="height:${height.toFixed(1)}%"></div>
          <div class="bar-cap">${esc(shortMonth(m.title))}</div>
        </div>`;
    })
    .join('');
  return `<div class="chart">${bars}</div>`;
}

function managerTable(manager, months) {
  const head = months
    .map(
      (m) =>
        `<th data-month="${esc(m.key)}"><span class="mfull">${esc(m.title.split(' ')[0])}</span><span class="mshort">${esc(shortMonth(m.title))}</span></th>`
    )
    .join('');
  const row = (label, pick) =>
    `<tr><th scope="row">${esc(label)}</th>${months
      .map((m) => `<td data-month="${esc(m.key)}">${esc(pick(manager.byMonth[m.key] || {}))}</td>`)
      .join('')}<td class="total">${esc(pick(manager.byMonth[ALL] || {}))}</td></tr>`;

  return `<table class="grid deals">
      <thead><tr><th scope="col"></th>${head}<th scope="col" class="total">Разом</th></tr></thead>
      <tbody>
        ${row('Угод', (b) => b.sales ?? 0)}
        ${row('Записів', (b) => b.success ?? 0)}
        ${row('Конверсія', (b) => (b.conversion == null ? '—' : b.conversion + '%'))}
        ${row('Бал', (b) => (b.avgScore == null ? '—' : b.avgScore))}
      </tbody>
    </table>`;
}

function categoryStrip(manager) {
  const total = manager.byMonth[ALL] || {};
  return `<div class="cats">
      ${PURPOSE_ORDER.map(
        (p) => `<div class="cat" style="--c:${PURPOSE_COLORS[p]}">
          <details class="tip"><summary title="Що це означає">i</summary><div class="tipbox"><b>${esc(PURPOSE_LABELS[p].plural)}</b><br>${esc(PURPOSE_LABELS[p].about)}</div></details>
          <span class="cat-icon">${PURPOSE_LABELS[p].icon}</span>
          <span class="cat-num" data-cat="${p}">${total[p] || 0}</span>
          <span class="cat-name">${esc(PURPOSE_LABELS[p].plural)}</span>
        </div>`
      ).join('')}
    </div>`;
}

function tabStrip(items, { cls, attr, activeKey }) {
  return `<div class="tabs">${items
    .map(
      (m) =>
        `<button type="button" class="${cls}${m.key === activeKey ? ' on' : ''}" ${attr}="${esc(m.key)}">${esc(m.title)}</button>`
    )
    .join('')}</div>`;
}

const withAllLast = (months) => [...months, { key: ALL, title: 'Весь період' }];

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
  const count = finding.examples.length;
  const details = count
    ? `<details>
        <summary>Переглянути приклади<span class="cnt">${count}</span></summary>
        <ul class="examples">${examples}</ul>
      </details>`
    : '';
  return `<article class="finding ${kind}">
      <h4>${esc(finding.claim)}</h4>
      ${finding.why ? `<p class="why">${esc(finding.why)}</p>` : ''}
      ${finding.action ? `<p class="action">${esc(finding.action)}</p>` : ''}
      ${details}
    </article>`;
}

function findingColumn(title, findings, kind, emptyText) {
  const body = findings.length
    ? findings.map((f) => findingBlock(f, kind)).join('')
    : `<p class="empty">${esc(emptyText)}</p>`;
  return `<section class="col ${kind}"><h3>${esc(title)}</h3>${body}</section>`;
}

function partialNote(manager) {
  if (!manager.partial || !manager.days) return '';
  return `<p class="warn">Сильні та слабкі сторони зібрані за ${manager.analysedDays} ${plural(manager.analysedDays, 'день', 'дні', 'днів')} із ${manager.days} — решту проаналізувати поки не вдалося, тож картина може бути неповною.</p>`;
}

function managerCard(manager, months) {
  const convSeries = Object.fromEntries(months.map((m) => [m.key, manager.byMonth[m.key]?.conversion ?? null]));
  const scoreSeries = Object.fromEntries(months.map((m) => [m.key, manager.byMonth[m.key]?.avgScore ?? null]));

  return `<section class="card manager" data-manager="${esc(manager.name)}">
      <h2>${esc(manager.display)}</h2>
      ${tabStrip(withAllLast(months), { cls: 'tab', attr: 'data-month', activeKey: ALL })}
      ${categoryStrip(manager)}
      <h3 class="sub">Динаміка по угодах</h3>
      ${managerTable(manager, months)}
      <div class="charts">
        <figure><figcaption>Конверсія, %</figcaption>${barChart(convSeries, { max: 100, months, suffix: '%' })}</figure>
        <figure><figcaption>Середній бал</figcaption>${barChart(scoreSeries, { max: 10, months, decimals: 1 })}</figure>
      </div>
      ${partialNote(manager)}
      <div class="cols">
        ${findingColumn('Сильні сторони', manager.strengths, 'plus', 'Стійких сильних патернів за період не набралось.')}
        ${findingColumn('Слабкі місця', manager.weaknesses, 'minus', 'Повторюваних помилок за період не зафіксовано.')}
      </div>
    </section>`;
}

function declineSection(declines) {
  const titles = declines.bucketTitles || declines.bucketLabels || {};
  const buckets = Object.entries(declines.buckets)
    .map(
      ([key, n]) => `<div class="bucket">
        <div class="bucket-num">${n}</div>
        <div class="bucket-name">${esc(titles[key] || key)}</div>
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

  const caseMonths = [...new Set(declines.cases.map((c) => monthKey(c.at)).filter(Boolean))]
    .sort()
    .map((key) => ({ key, title: monthTitle(key) }));

  const cases = declines.cases.length
    ? declines.cases
        .map(
          (c) => `<tr data-dm="${esc(monthKey(c.at))}">
          <td class="nowrap" data-label="Дата">${esc(formatDateShort(c.at))}</td>
          <td data-label="Причина">${esc(c.reason || c.bucketLabel || '—')}</td>
          <td data-label="Клієнт">${esc(c.clientName || 'Невідомо')}<br><span class="phone">${esc(c.clientPhone || '—')}</span></td>
          <td data-label="Менеджер">${esc(c.manager)}</td>
          <td class="quote" data-label="Слова менеджера">${esc(c.quote || '')}</td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="empty">Жодного випадку не зафіксовано.</td></tr>';

  const cov = declines.coverage || {};
  const notBooked = cov.notBooked ?? 0;
  return `<section class="card declines">
      <h2>Найбільш поширені причини відмов від обслуговування</h2>
      <p class="lead">За період не закрилося ${notBooked} ${plural(notBooked, 'угода', 'угоди', 'угод')}. Частину з них СТО взяти не могло — не було вільного місця, потрібної деталі або такої послуги взагалі. В решті випадків сервіс міг виконати роботу, але клієнт вирішив інакше.</p>
      <h3 class="sub">Причини відмов</h3>
      <div class="buckets">${buckets}</div>
      <h3 class="sub">Часті причини</h3>
      <ul class="reasons">${reasons}</ul>
      <h3 class="sub">Кому відмовили — можна передзвонити</h3>
      ${caseMonths.length ? tabStrip(withAllLast(caseMonths), { cls: 'dtab', attr: 'data-dm', activeKey: ALL }) : ''}
      <div class="scroll">
        <table class="grid cases">
          <colgroup>
            <col class="c-date"><col class="c-reason"><col class="c-client"><col class="c-mgr"><col>
          </colgroup>
          <thead><tr><th>Дата</th><th>Причина</th><th>Клієнт</th><th>Менеджер</th><th>Слова менеджера</th></tr></thead>
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
      <h2>Над чим варто попрацювати</h2>
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
        <li><b>Відмов СТО — ${report.declines.serviceTotal}, а незакритих угод — ${d.notBooked ?? 0}</b>, і ці числа не мусять збігатися. Коли менеджер одразу каже «таким не займаємось», система визначає такий дзвінок як звернення без можливості запису, а не як угоду. Проте у таблицю відмов такі дзвінки все одно заносяться: це втрачений клієнт незалежно від причини відмови.</li>
        <li><b>Приклади діалогів</b> не переказані. Кожен — дослівний рядок із розмови, знайдений у записі повторно вже кодом; те, що не знайшлося, у звіт не потрапляє.</li>
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
        `<button type="button" class="mtab${i === 0 ? ' on' : ''}" data-manager="${esc(m.name)}">${esc(m.display)}</button>`
    )
    .join('');

  const legend = PURPOSE_ORDER.map(
    (p) =>
      `<li><i style="background:${PURPOSE_COLORS[p]}"></i>${esc(PURPOSE_LABELS[p].plural)} — <b>${totals.purposes[p] || 0}</b> <span class="pct">(${share(totals.purposes[p] || 0, totals.calls)})</span></li>`
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
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    -webkit-text-size-adjust: 100%; }
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
  .legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; flex: none; }
  .legend .pct { color: var(--muted); }
  .mtabs { display: flex; gap: 8px; flex-wrap: wrap; position: sticky; top: 0; z-index: 30;
    background: var(--bg); padding: 10px 0; margin-bottom: 8px; }
  .mtab { border: 1px solid var(--line); background: var(--card); color: var(--ink);
    border-radius: 999px; padding: 9px 18px; font-size: 15px; font-weight: 600; cursor: pointer; }
  .mtab.on { background: var(--ink); border-color: var(--ink); color: #fff; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 14px; }
  .tab, .dtab { border: 1px solid var(--line); background: #fafbfc; color: var(--ink);
    border-radius: 999px; padding: 5px 12px; font-size: 13px; cursor: pointer; }
  .tab.on, .dtab.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .cats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 14px; }
  .cat { position: relative; border: 1px solid var(--line); border-left: 4px solid var(--c);
    border-radius: 10px; padding: 10px 8px; text-align: center; }
  .cat-icon { display: block; font-size: 15px; }
  .cat-num { display: block; font-size: 22px; font-weight: 700; }
  .cat-name { display: block; font-size: 12px; color: var(--muted); }
  .tip { position: absolute; top: 6px; right: 6px; }
  .tip > summary { list-style: none; cursor: pointer; width: 18px; height: 18px; border-radius: 50%;
    border: 1px solid var(--line); color: var(--muted); font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; margin: 0; padding: 0; }
  .tip > summary::-webkit-details-marker, .tip > summary::marker { display: none; content: ""; }
  .tip[open] > summary { background: var(--ink); border-color: var(--ink); color: #fff; }
  .tipbox { position: absolute; right: 0; top: 24px; width: 230px; text-align: left;
    background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
    box-shadow: 0 10px 28px rgba(16, 24, 40, .14); font-size: 12px; line-height: 1.45;
    color: var(--muted); z-index: 20; }
  .tipbox b { color: var(--ink); }
  table.grid { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.grid th, table.grid td { border-bottom: 1px solid var(--line); padding: 8px 6px; text-align: right; }
  table.grid th[scope="row"], table.grid thead th:first-child { text-align: left; }
  table.grid thead th { color: var(--muted); font-weight: 600; }
  .total { font-weight: 700; }
  td.sel, th.sel { background: #eef4ff; }
  .mshort { display: none; }
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
  .finding details > summary { cursor: pointer; font-size: 13px; color: var(--accent); margin-top: 8px;
    list-style: none; display: inline-flex; align-items: center; gap: 6px; }
  .finding details > summary::-webkit-details-marker { display: none; }
  .finding details > summary::before { content: "\\25B8"; font-size: 11px; }
  .finding details[open] > summary::before { content: "\\25BE"; }
  .cnt { background: #eef0f4; color: var(--muted); border-radius: 999px; padding: 0 7px; font-size: 11px; }
  .examples { list-style: none; margin: 10px 0 0; padding: 0; }
  .examples li { margin-bottom: 10px; }
  blockquote { margin: 0; padding: 8px 10px; border: 1px solid var(--line);
    border-radius: 8px; font-size: 14px; background: #f7f8fa; }
  .finding.plus blockquote { border-color: #9fd3b8; background: #f1f9f4; }
  .finding.minus blockquote { border-color: #e6b0a9; background: #fdf4f2; }
  .note { font-size: 12px; color: var(--muted); padding: 3px 10px 0; }
  .when { font-size: 11px; color: var(--muted); padding: 0 10px; }
  .empty { color: var(--muted); font-size: 14px; }
  .warn { background: #fff6e5; border: 1px solid #f0dcb4; border-radius: 8px;
    padding: 8px 10px; font-size: 13px; color: #7a5a1e; margin: 14px 0 0; }
  .buckets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .bucket { border: 1px solid var(--line); border-radius: 10px; padding: 14px; text-align: center; }
  .bucket-num { font-size: 30px; font-weight: 700; }
  .bucket-name { color: var(--muted); font-size: 13px; }
  ul.reasons { list-style: none; margin: 0; padding: 0; }
  ul.reasons li { display: grid; grid-template-columns: minmax(120px, 1fr) 2fr 44px;
    grid-template-areas: "name bar num"; gap: 10px; align-items: center; padding: 5px 0; font-size: 14px; }
  .reason-name { grid-area: name; }
  .reason-bar { grid-area: bar; background: #eef0f4; border-radius: 999px; height: 10px; overflow: hidden; }
  .reason-bar i { display: block; height: 100%; background: #9db4dd; }
  li.service .reason-bar i { background: #d79a93; }
  .reason-num { grid-area: num; text-align: right; font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table.cases { table-layout: fixed; min-width: 720px; }
  table.cases th, table.cases td { text-align: left; vertical-align: top; font-size: 13px; }
  table.cases thead th { white-space: nowrap; }
  table.cases .quote { color: var(--muted); }
  table.cases .nowrap, table.cases .phone { white-space: nowrap; }
  table.cases td::before { display: none; }
  .c-date { width: 78px; } .c-reason { width: 190px; } .c-client { width: 178px; } .c-mgr { width: 108px; }
  .phone { color: var(--muted); font-size: 12px; }
  .fine { font-size: 13px; color: var(--muted); margin-top: 12px; }
  .method ul { margin: 0; padding-left: 18px; }
  .method li { margin-bottom: 8px; font-size: 14px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; padding: 8px 0 24px; }

  @media (max-width: 760px) {
    .wrap { padding: 12px; }
    .card { padding: 14px; border-radius: 12px; }
    h1 { font-size: 21px; }
    h2 { font-size: 18px; }
    .hero .big { font-size: 34px; }
    .cols, .charts, .buckets { grid-template-columns: 1fr; }
    .cats { grid-template-columns: repeat(2, 1fr); }
    .mtab { padding: 8px 14px; font-size: 14px; }

    .mfull { display: none; }
    .mshort { display: inline; }
    table.grid.deals { font-size: 13px; }
    table.grid.deals th, table.grid.deals td { padding: 7px 2px; }
    table.grid.deals th[scope="row"] { font-size: 12px; }

    .scroll { overflow-x: visible; }
    table.cases { display: block; min-width: 0; table-layout: auto; }
    table.cases colgroup, table.cases thead { display: none; }
    table.cases tbody, table.cases tr, table.cases td { display: block; width: auto; }
    table.cases tr { border: 1px solid var(--line); border-radius: 10px;
      padding: 10px 12px; margin-bottom: 10px; }
    table.cases td { border: 0; padding: 4px 0; font-size: 14px; }
    table.cases td::before { display: block; content: attr(data-label); color: var(--muted);
      font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
    table.cases td.quote { border-top: 1px solid var(--line); margin-top: 6px; padding-top: 8px; }
    table.cases td:empty { display: none; }

    ul.reasons li { grid-template-columns: 1fr auto;
      grid-template-areas: "name num" "bar bar"; gap: 4px 10px; }
    .reason-bar { height: 8px; }

    .tipbox { width: min(230px, 66vw); }
    .cat:nth-child(odd) .tipbox { left: 0; right: auto; }
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
      <p class="lead" style="flex:1 1 320px;margin:0">Стільки часу довелося б прослухати вручну, щоб знати все, що є в цьому звіті — приблизно ${days} ${esc(plural(days, 'робочий день', 'робочі дні', 'робочих днів'))} суцільного прослуховування. Усі ${totals.calls} ${esc(plural(totals.calls, 'розмову', 'розмови', 'розмов'))} розшифровано й розібрано автоматично.</p>
    </div>
  </header>

  <section class="card">
    <h2>Структура дзвінків</h2>
    <div class="mix">
      ${donut(totals.purposes, totals.calls)}
      <ul class="legend">${legend}</ul>
    </div>
  </section>

  <div class="mtabs">${managerTabs}</div>

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
  var CATS = ${json(PURPOSE_ORDER)};

  function applyMonth(card, month) {
    var bucket = (DATA[card.dataset.manager] || {})[month] || {};
    CATS.forEach(function (c) {
      var el = card.querySelector('[data-cat="' + c + '"]');
      if (el) el.textContent = bucket[c] || 0;
    });
    card.querySelectorAll('[data-month]').forEach(function (el) {
      if (el.classList.contains('tab')) el.classList.toggle('on', el.dataset.month === month);
      else el.classList.toggle('sel', month !== ALL && el.dataset.month === month);
    });
  }

  var cards = document.querySelectorAll('.manager');
  cards.forEach(function (card) {
    card.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () { applyMonth(card, tab.dataset.month); });
    });
    applyMonth(card, ALL);
  });

  var tabs = document.querySelectorAll('.mtab');
  function showManager(name) {
    cards.forEach(function (card) { card.hidden = card.dataset.manager !== name; });
    tabs.forEach(function (tab) { tab.classList.toggle('on', tab.dataset.manager === name); });
  }
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () { showManager(tab.dataset.manager); });
  });
  if (tabs.length) showManager(tabs[0].dataset.manager);

  var rows = document.querySelectorAll('tr[data-dm]');
  var dtabs = document.querySelectorAll('.dtab');
  function showDeclineMonth(month) {
    rows.forEach(function (row) { row.hidden = month !== ALL && row.dataset.dm !== month; });
    dtabs.forEach(function (tab) { tab.classList.toggle('on', tab.dataset.dm === month); });
  }
  dtabs.forEach(function (tab) {
    tab.addEventListener('click', function () { showDeclineMonth(tab.dataset.dm); });
  });
  if (dtabs.length) showDeclineMonth(ALL);

  document.addEventListener('click', function (event) {
    document.querySelectorAll('.tip[open]').forEach(function (tip) {
      if (!tip.contains(event.target)) tip.removeAttribute('open');
    });
  });
})();
</script>
</body>
</html>`;
}

export { renderGlobalReport };
