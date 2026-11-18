const COMPLAINT_TYPES = [
  {
    key: 'no_callback',
    label: 'Не передзвонили',
    about: 'Клієнт нагадує, що йому обіцяли передзвонити, або сам телефонує вже не вперше з того самого питання.',
  },
  {
    key: 'long_wait',
    label: 'Довго чекає',
    about: 'Затягнувся ремонт, строк або відповідь на запит: «коли вже», «ви казали в понеділок».',
  },
  {
    key: 'price',
    label: 'Обурення ціною',
    about: 'Клієнт каже, що дорого, дорожче за домовлене або дорожче, ніж в інших.',
  },
  {
    key: 'quality',
    label: 'Претензія до якості',
    about: 'Після наших робіт щось не працює або довелось повертатись удруге.',
  },
  {
    key: 'attitude',
    label: 'Невдоволення ставленням',
    about: 'Клієнт прямо каже, що його ігнорують або що з ним так не можна: «тобі не цікаво працювати?».',
  },
  {
    key: 'misinform',
    label: 'Ввели в оману',
    about: 'Домовлялись про одне, вийшло інше: інша сума, інші строки, інший обсяг робіт.',
  },
];

const COMPLAINT_KEYS = COMPLAINT_TYPES.map((t) => t.key);
const BY_KEY = new Map(COMPLAINT_TYPES.map((t) => [t.key, t]));

const complaintLabel = (key) => BY_KEY.get(key)?.label || null;

function complaintPromptList() {
  return COMPLAINT_TYPES.map((t) => `- "${t.key}" — ${t.label}. ${t.about}`).join('\n');
}

export { COMPLAINT_TYPES, COMPLAINT_KEYS, complaintLabel, complaintPromptList };
