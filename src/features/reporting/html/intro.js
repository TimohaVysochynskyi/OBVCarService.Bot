import { ALL } from '../globalReportData.js';
import { esc } from './format.js';
import { CARD, H2, LEAD } from './tokens.js';
import { tabStrip, withAllLast } from './widgets.js';

const INTRO_COLOR = '#2f7d58';

function introBar(field, label) {
  return `<div class="mt-2">
      <div class="flex items-baseline justify-between gap-2 text-sm">
        <span class="text-muted">${esc(label)}</span>
        <span class="tabular-nums" data-intro-pct="${field}"></span>
      </div>
      <div class="mt-1 h-2 w-full overflow-hidden rounded-full bg-line">
        <div class="h-full rounded-full" style="background:${INTRO_COLOR};width:0%" data-intro-bar="${field}"></div>
      </div>
    </div>`;
}

function introCard(manager) {
  return `<article class="rounded-xl border border-line p-3" data-intro-card="${esc(manager.name)}">
      <div class="flex items-baseline gap-2">
        <span class="text-xs uppercase tracking-wide text-muted">Менеджер</span>
        <span class="font-semibold">${esc(manager.display)}</span>
      </div>
      <div class="mt-1 text-sm text-ink" data-intro-sub></div>
      ${introBar('name', 'назвав своє імʼя')}
      ${introBar('company', 'назвав сервіс')}
      <div class="mt-2 text-sm tabular-nums text-muted" data-intro-dir></div>
    </article>`;
}

function introSection(report) {
  const intro = report.intro;
  if (!intro?.managers?.length || !intro.total?.checked) return '';
  return `<section class="${CARD}">
    <h2 class="${H2}">Представлення</h2>
    <p class="${LEAD}">Чи називає менеджер своє імʼя та назву сервісу на початку розмови — і на вхідному дзвінку, і на вихідному. Рахується лише на персональних номерах: на стаціонарних саме представлення й дозволяє визначити, хто взяв слухавку, тож там непредставлені дзвінки вже видно як «None» у розділі «Номери».</p>
    ${tabStrip(withAllLast(report.months), 'data-intro-tab', ALL)}
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${intro.managers.map(introCard).join('')}</div>
  </section>`;
}

export {
  INTRO_COLOR,
  introBar,
  introCard,
  introSection,
};
