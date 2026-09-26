import { definePrompt } from './prompts.js';

const CALL_PURPOSES = ['sales', 'info', 'other', 'personal'];

const NON_SALES_PURPOSES = ['info', 'other', 'personal'];

const PURPOSE_LABELS = {
  sales: {
    icon: '💰',
    plural: 'Угоди',
    one: 'угода',
    about: 'Клієнта можна було записати на сервіс або продати йому послугу: питає про ремонт, ціну чи вільний час.',
  },
  info: {
    icon: 'ℹ️',
    plural: 'Інформаційні',
    one: 'інформаційний',
    about: 'Розмова про авто чи послугу, але записувати нікого не треба: статус ремонту, підтвердження вже наявного запису, технічна порада.',
  },
  other: {
    icon: '⚙️',
    plural: 'Службові',
    one: 'службовий',
    about: 'Робочі дзвінки не з клієнтом: постачальники й магазини запчастин, колеги, перевізники, автовідповідач, помилковий набір.',
  },
  personal: {
    icon: '👤',
    plural: 'Особисті',
    one: 'особистий',
    about: 'Теми, не повʼязані з роботою СТО: рідні, друзі, побутові справи.',
  },
};

const purposeRules = definePrompt({
  key: 'purpose',
  group: 'call',
  job: 'map',
  button: '🗂 Категорія дзвінка',
  title: '🗂 *Категорія дзвінка*',
  about:
    'Як AI вирішує, чим був дзвінок: угода, інформаційний, службовий чи особистий. ' +
    'Від цього залежить, які дзвінки взагалі оцінюються як продажі — а отже і конверсія.',
});

const isSales = (purpose) => purpose === 'sales' || purpose == null;

const purposeLabel = (purpose) => PURPOSE_LABELS[purpose] || null;

export { CALL_PURPOSES, NON_SALES_PURPOSES, PURPOSE_LABELS, purposeRules, isSales, purposeLabel };
