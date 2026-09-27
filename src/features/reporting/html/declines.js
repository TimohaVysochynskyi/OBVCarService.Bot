import { ALL } from '../globalReportData.js';
import { esc, formatDateShort, monthKey, monthTitle, plural } from './format.js';
import { CARD, H2, H3, LEAD } from './tokens.js';
import { barList, tabStrip, withAllLast } from './widgets.js';

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

export {
  declineSection,
};
