import { CARD, H2, LEAD } from './tokens.js';
import { barList } from './widgets.js';

function stagesSection(stages) {
  if (!stages.length) return '';
  const max = Math.max(...stages.map((s) => s.count));
  const items = barList(stages.map((s) => ({ label: s.stage, count: s.count, side: 'service' })), { max });
  return `<section class="${CARD}">
      <h2 class="${H2}">Над чим варто попрацювати</h2>
      <p class="${LEAD}">Найслабший етап розмови, визначений для кожної угоди окремо.</p>
      <ul class="list-none p-0">${items}</ul>
    </section>`;
}

export {
  stagesSection,
};
