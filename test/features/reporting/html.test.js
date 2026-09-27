import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../../helpers/repo.js';

process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/x';

const { renderGlobalReport } = await import('../../../src/features/reporting/globalReportHtml.js');

const bucket = (o) => ({ calls: 0, sales: 0, info: 0, other: 0, personal: 0, success: 0, reachable: 0, avgScore: null, conversion: null, ...o });
const mgr = (name, extra = {}) => ({
  name,
  display: name,
  byMonth: {
    '2026-06': bucket({ calls: 10, sales: 4, success: 2, reachable: 4, conversion: 50, avgScore: 6.8, personal: 1 }),
    '2026-07': bucket({ calls: 20, sales: 8, success: 5, reachable: 8, conversion: 63, avgScore: 7.1 }),
    all: bucket({ calls: 30, sales: 12, success: 7, reachable: 12, conversion: 58, avgScore: 7, personal: 1 }),
  },
  strengths: [{ claim: 'Добре закриває', why: 'бо так', action: 'роби так', examples: [{ quote: 'Записую вас на <b>вівторок</b>', note: null, at: '2026-07-02T09:00:00.000Z' }] }],
  weaknesses: [{ claim: 'Перебиває', why: 'бо клієнт не договорює', action: 'дослухай', examples: [{ quote: 'А ось тут "стоп" & далі', note: 'клієнт не договорив', at: null }] }],
  analysedDays: 60,
  days: 93,
  partial: false,
  ...extra,
});

const report = {
  generatedAt: '2026-09-19T10:00:00.000Z',
  period: { start: '2026-06-19T00:00:00.000Z', end: '2026-09-19T00:00:00.000Z' },
  totals: { calls: 1823, seconds: 138240, hours: 38.4, managers: 3, purposes: { sales: 216, info: 536, other: 1040, personal: 31 } },
  months: [{ key: '2026-06', title: 'червень 2026' }, { key: '2026-07', title: 'липень 2026' }],
  managers: [mgr('Роман'), mgr('Андрій'), mgr('Володимир')],
  stages: [{ stage: 'закриття угоди', count: 79 }, { stage: 'допродаж', count: 9 }],
  declines: {
    buckets: { no_slot: 23, no_parts: 1, out_of_scope: 12 },
    bucketLabels: { no_slot: 'Черга', no_parts: 'Деталі', out_of_scope: 'Не наш профіль' },
    bucketTitles: { no_slot: 'Немає вільного місця', no_parts: 'Відсутність деталей', out_of_scope: 'Не наш профіль' },
    serviceTotal: 36,
    cases: [{
      at: '2026-07-02T09:00:00.000Z', manager: 'Роман', bucket: 'no_slot', bucketLabel: 'Черга',
      bucketTitle: 'Немає вільного місця', bucketFull: 'x', reason: 'Зайнято, немає вільного часу',
      quote: 'Сьогодні все розписано', clientName: 'Олег', clientPhone: '+380671112233',
    }],
    reasons: [
      { key: 'busy', label: 'Зайнято, немає вільного часу', side: 'service', count: 20 },
      { key: 'price', label: 'Не влаштувала ціна', side: 'client', count: 9 },
    ],
    coverage: { notBooked: 97, notBookedBlocked: 7, clientExplained: 90, unchecked: 0, blockerUnchecked: 0 },
  },
};

const html = renderGlobalReport(report);
const has = (s) => html.includes(s);
const flat = html.replace(/\s+/g, ' ').replace(/> </g, '><');
const css = readSrc('features/reporting/site/app.css');
const firstFinding = html.slice(html.indexOf('<article class="break-avoid'), html.indexOf('</article>'));

test('валідний документ', () => {
  assert.ok(html.startsWith('<!doctype html>'));
});

test('жодного зовнішнього ресурсу', () => {
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html));
});

test('без таймкодів плеєрів не зʼявляється', () => {
  assert.ok(!html.includes('data-clip='));
});

test('заголовок «Категорії дзвінків»', () => {
  assert.ok(has('>Категорії дзвінків</h2>'));
});

test('старого заголовка «На що йде телефонна лінія» не лишилось', () => {
  assert.ok(!has('На що йде телефонна лінія'));
});

test('частка поруч із кількістю', () => {
  assert.ok(/<td[^>]*>216<\/td><td[^>]*>12%<\/td>/.test(flat));
});

test('велика частка — цілим числом', () => {
  assert.ok(has('>57%<'));
});

test('мала частка не згортається в «2%»', () => {
  assert.ok(has('>1.7%<'));
});

test('таб на кожного менеджера', () => {
  assert.equal((html.match(/data-manager-tab="/g) || []).length, report.managers.length);
});

test('панель на кожного менеджера', () => {
  assert.equal((html.match(/data-manager-card="/g) || []).length, 3);
});

test('місяці — всередині кожної картки', () => {
  assert.equal((html.match(/data-month-tab data-month="/g) || []).length, report.managers.length * (report.months.length + 1));
});

test('менеджери зверху, місяці нижче', () => {
  assert.ok(html.indexOf('data-manager-tab=') < html.indexOf('data-manager-card='));
});

test('приклади сховані під кнопкою в кожному finding', () => {
  assert.equal((html.match(/<details class="disclosure/g) || []).length, 6);
});

test('кнопка названа «Переглянути приклади»', () => {
  assert.ok(/<summary[^>]*>Переглянути приклади/.test(html));
});

test('claim видно без кліку', () => {
  assert.ok(firstFinding.indexOf('Добре закриває') < firstFinding.indexOf('<details class="disclosure'));
});

test('пояснення видно без кліку', () => {
  assert.ok(firstFinding.indexOf('бо так') < firstFinding.indexOf('<details class="disclosure'));
});

test('цитата — лише під кнопкою', () => {
  assert.ok(firstFinding.indexOf('Записую вас') > firstFinding.indexOf('<details class="disclosure'));
});

test('на кнопці видно кількість прикладів', () => {
  assert.ok(/Переглянути приклади<span[^>]*>1<\/span>/.test(html));
});

test('розмітка в цитаті екранована', () => {
  assert.ok(has('Записую вас на &lt;b&gt;вівторок&lt;/b&gt;'));
});

test('амперсанд екранований', () => {
  assert.ok(has('&amp; далі'));
});

test('заголовок «Над чим варто попрацювати»', () => {
  assert.ok(has('>Над чим варто попрацювати</h2>'));
});

test('старий заголовок «Де втрачаються угоди» прибрано', () => {
  assert.ok(!has('Де втрачаються угоди'));
});

test('формулювання «система визначає»', () => {
  assert.ok(has('система визначає'));
});

test('слова «довідку» немає', () => {
  assert.ok(!has('довідку'));
});

test('формулювання «все одно заносяться»', () => {
  assert.ok(has('все одно заносяться'));
});

test('стара форма «все одно входять» прибрана', () => {
  assert.ok(!has('все одно входять'));
});

test('формулювання «незалежно від причини відмови»', () => {
  assert.ok(has('незалежно від причини відмови'));
});

test('стара форма «як розмову позначили» прибрана', () => {
  assert.ok(!has('як розмову позначили'));
});

test('«Приклади діалогів» замість «Цитати»', () => {
  assert.ok(has('<b>Приклади діалогів</b> не переказані'));
});

test('старий підпис «Цитати» прибрано', () => {
  assert.ok(!has('<b>Цитати</b>'));
});

test('нове формулювання про умови розрахунків', () => {
  assert.ok(has('умови розрахунків потребують щонайменше двох прикладів'));
});

test('«Патерн вимагає» прибрано', () => {
  assert.ok(!has('Патерн вимагає'));
});

test('хвіст про малу кількість угод видалено', () => {
  assert.ok(!has('угод надто мало'));
});

test('нове формулювання про склад звіту', () => {
  assert.ok(has('справді відбулася розмова'));
});

test('стара форма «дзвінки з розшифровкою» прибрана', () => {
  assert.ok(!has('дзвінки з розшифровкою'));
});

test('телефон клієнта на місці', () => {
  assert.ok(has('+380671112233'));
});

test('дисклеймер про записаних на місці', () => {
  assert.ok(has('не записали'));
});

test('слова «продажний» немає', () => {
  assert.ok(!has('продажн'));
});

test('«Весь період» перенесено в кінець перемикача', () => {
  assert.ok(html.indexOf('data-month="2026-06"') < html.indexOf('data-month="all"'));
});

test('...і лишається обраним за замовчуванням', () => {
  assert.ok(/data-month="all"[^>]*>Весь період<\/button>/.test(html));
});

test('саме він позначений обраним', () => {
  assert.ok(/data-month-tab data-month="all" aria-selected="true"/.test(html));
});

test('позначка i на кожній картці виду дзвінка і на кожному показнику порівняння', () => {
  assert.equal((html.match(/data-tip/g) || []).length, 3 * 4 + 3);
});

test('пояснення у спливному віконці', () => {
  assert.ok(/<details data-tip[\s\S]{0,600}?Клієнта можна було записати на сервіс/.test(html));
});

test('текст пояснення для угод', () => {
  assert.ok(html.includes('Клієнта можна було записати'));
});

test('текст пояснення для особистих', () => {
  assert.ok(html.includes('не повʼязані з роботою СТО'));
});

test('цитати переваг у зеленій обводці', () => {
  assert.ok(/rounded-full bg-plus[\s\S]{0,900}?blockquote class="[^"]*border-plus\//.test(html));
});

test('цитати недоліків у червоній обводці', () => {
  assert.ok(/rounded-full bg-minus[\s\S]{0,900}?blockquote class="[^"]*border-minus\//.test(html));
});

test('новий заголовок розділу відмов', () => {
  assert.ok(html.includes('>Найбільш поширені причини відмов від обслуговування</h2>'));
});

test('старий заголовок «Чому клієнт не записався» прибрано', () => {
  assert.ok(!html.includes('Чому клієнт не записався'));
});

test('формулювання про «дві різні речі» прибрано', () => {
  assert.ok(!html.includes('дві різні речі'));
});

test('зрозуміле формулювання з відмінюванням', () => {
  assert.ok(html.includes('За період не закрилося 97 угод'));
});

test('«Причини відмов» замість «Не змогли взяти»', () => {
  assert.ok(html.includes('>Причини відмов</h3>'));
});

test('старий підзаголовок «Не змогли взяти» прибрано', () => {
  assert.ok(!html.includes('Не змогли взяти'));
});

test('картка «Немає вільного місця»', () => {
  assert.ok(html.includes('Немає вільного місця'));
});

test('картка «Відсутність деталей»', () => {
  assert.ok(html.includes('Відсутність деталей'));
});

test('картка «Не наш профіль»', () => {
  assert.ok(html.includes('Не наш профіль'));
});

test('дата в таблиці скорочена до двох цифр року', () => {
  assert.ok(html.includes('02.07.26'));
});

test('колонку «Категорія» прибрано з таблиці', () => {
  assert.ok(!has('<th>Категорія</th>'));
});

test('у таблиці лишилось пʼять колонок', () => {
  assert.equal((html.match(/<col /g) || []).length, 4);
});

test('шапка таблиці починається з дати й причини', () => {
  assert.ok(/<th[^>]*>Дата<\/th><th[^>]*>Причина<\/th>/.test(flat));
});

test('кожна комірка підписана — для карткового вигляду на телефоні', () => {
  assert.ok(has('data-label="Клієнт"'));
});

test('рядок таблиці знає свій місяць', () => {
  assert.ok(has('data-decline-month="2026-07"'));
});

test('таби місяців над таблицею відмов', () => {
  assert.equal((html.match(/data-decline-tab="/g) || []).length, 2);
});

test('«Весь період» обрано за замовчуванням у відмовах', () => {
  assert.ok(/data-decline-tab="all" aria-selected="true"/.test(html));
});

test('...і стоїть у кінці', () => {
  assert.ok(/data-decline-tab="2026-07"[\s\S]*?data-decline-tab="all"/.test(html));
});

test('стрілка більше не чіпляється до значка i', () => {
  assert.ok(!/[^.\-\w]details\s*>?\s*summary::?before/.test(css));
});

test('стрілка лишилась лише у «Переглянути приклади»', () => {
  assert.ok(/\.disclosure\s*>\s*summary::?before/.test(css));
});

test('кружечок i заливається, «i» стає білою', () => {
  assert.ok(css.includes('[data-tip][open]>summary{background:var(--color-ink)') && css.includes('color:#fff'));
});

test('є мобільна версія', () => {
  assert.ok(/@media \(max-width:\s*767px\)/.test(css));
});

test('таблиця відмов на телефоні стає картками', () => {
  assert.ok(html.includes('cards-on-mobile') && /\.cards-on-mobile[^{]*\{[^}]*display:block/.test(css));
});

test('...із підписами полів', () => {
  assert.ok(/content:\s*attr\(data-label\)/.test(css));
});

test('таблиці по місяцях більше немає — її замінив графік', () => {
  assert.ok(!/data-month="[^"]+"[^>]*>\s*\d/.test(html));
});

test('у картці менеджера є графік із перемикачами ліній', () => {
  assert.ok(/data-trend="/.test(html) && /data-series="sales"/.test(html));
});

test('смужки причин переносяться під назву', () => {
  assert.ok(html.includes('order-last col-span-2') && html.includes('sm:order-none'));
});

test('заголовки таблиці вирівняні так само, як дані', () => {
  assert.ok(/<thead class="text-left text-muted">/.test(html));
});

test('фіксована розкладка — колонки не їдуть', () => {
  assert.ok(html.includes('table-fixed'));
});

test('ширини колонок задані явно', () => {
  assert.ok(html.includes('<colgroup>'));
});

test('дата не переноситься на два рядки', () => {
  assert.ok(html.includes('whitespace-nowrap'));
});

test('розмір документа розумний', () => {
  assert.ok(html.length / 1024 < 200);
});
