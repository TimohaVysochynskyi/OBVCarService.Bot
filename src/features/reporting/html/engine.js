import { esc, share } from './format.js';
import { CARD, H2, H3, LEAD } from './tokens.js';
import { barList, lineChart } from './widgets.js';

const MAX_CARS = 10;

function monthsTable(months) {
  const rows = months
    .map(
      (m) => `<tr>
        <td class="text-left">${esc(m.title)}</td>
        <td>${m.count}</td>
        <td>${esc(share(m.count, m.total))}</td>
        <td>${m.booked}</td>
      </tr>`
    )
    .join('');
  return `<div class="overflow-x-auto"><table class="grid w-auto text-sm">
      <thead><tr>
        <th class="text-left">Місяць</th><th>Звернень</th><th>Частка дзвінків</th><th>Записались</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function examplesBlock(examples) {
  if (!examples.length) return '';
  const items = examples
    .map(
      (e) => `<li class="border-line border-t py-2 first:border-t-0">
        <div class="text-xs text-muted">${esc(e.at)} · ${esc(e.manager)} · ${esc(e.service)}${e.car ? ` · ${esc(e.car)}` : ''}</div>
        <div class="text-sm">«${esc(e.quote)}»</div>
      </li>`
    )
    .join('');
  return `<details class="mt-4"><summary class="cursor-pointer text-sm text-muted">Переглянути приклади звернень</summary>
      <ul class="mt-2 list-none p-0">${items}</ul>
    </details>`;
}

function engineSection(report) {
  const engine = report.engine;
  if (!engine?.total) return '';

  const maxMonth = Math.max(1, ...engine.months.map((m) => m.count));
  const series = [{ byMonth: Object.fromEntries(engine.months.map((m) => [m.key, { count: m.count }])) }];
  const maxService = Math.max(1, ...engine.services.map((s) => s.count));
  const cars = engine.cars.slice(0, MAX_CARS);
  const maxCar = Math.max(1, ...cars.map((c) => c.count));

  return `<section class="${CARD}">
    <h2 class="${H2}">Звернення по двигуну</h2>
    <p class="${LEAD}">Скільки клієнтів телефонували саме по мотору, яка робота їм була потрібна і про які авто йшлося. Рахується по всіх розмовах, а не лише по тих, що визнані угодами: запит про ремонт двигуна важливий навіть тоді, коли клієнт просто дізнавався ціну. Усього знайдено ${engine.total} звернен${engine.total === 1 ? 'ня' : 'ь'}, із них ${engine.repairTotal} — саме ремонтні роботи, решта — планове обслуговування.</p>

    ${lineChart(series, engine.months, 'count', { max: maxMonth, title: 'Звернень по двигуну за місяць' })}

    <h3 class="${H3}">По місяцях</h3>
    ${monthsTable(engine.months)}

    <h3 class="${H3}">Яка робота потрібна</h3>
    <ul class="list-none p-0">${barList(engine.services.map((s) => ({ label: s.label, count: s.count })), { max: maxService })}</ul>

    ${cars.length ? `<h3 class="${H3}">Які авто</h3>
    <ul class="list-none p-0">${barList(cars.map((c) => ({ label: c.car, count: c.count })), { max: maxCar })}</ul>` : ''}

    ${examplesBlock(engine.examples)}
  </section>`;
}

export { engineSection };
