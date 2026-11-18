const ENGINE_WORDS = [
  'мотор', 'мотар', 'двигун', 'двигат', 'двіжок', 'движок', 'двіж', 'движ', 'двс',
  'капремонт', 'кап ремонт', 'капіталк', 'капиталк', 'капіталн', 'капитальн',
  'гбц', 'головк', 'поршн', 'шатун', 'колінвал', 'коленвал', 'вкладиш',
  'клапан', 'розподілвал', 'распредвал', 'грм', 'ланцюг грм', 'ремінь грм',
  'турбін', 'турбин', 'турбо', 'компресі', 'компресси', 'компрессі',
  'масложор', 'жере масло', 'жрет масло', 'ест масло', 'їсть масло',
  'троїть', 'троит', 'детонац', 'стукіт', 'стуки в', 'застукав',
  'прокладк', 'сальник', 'маслознім', 'маслосъём', 'маслосъем',
  'форсунк', 'паливна апаратура', 'топливная аппаратура', 'тнвд',
];

const ENGINE_SERVICES = [
  {
    key: 'overhaul',
    label: 'Капітальний ремонт',
    about: 'Повна переборка двигуна: поршнева, колінвал, вкладиші, розточка блоку.',
  },
  {
    key: 'head',
    label: 'Ремонт головки (ГБЦ)',
    about: 'Головка блоку, клапани, прокладка ГБЦ, маслознімні ковпачки.',
  },
  {
    key: 'diagnostics',
    label: 'Діагностика двигуна',
    about: 'Пошук причини: троїть, стукіт, не заводиться, горить чек, замір компресії.',
  },
  {
    key: 'replacement',
    label: 'Заміна двигуна',
    about: 'Поставити інший двигун: контрактний, з розборки, свап.',
  },
  {
    key: 'turbo',
    label: 'Турбіна',
    about: 'Ремонт або заміна турбіни, інтеркулера, системи наддуву.',
  },
  {
    key: 'fuel',
    label: 'Паливна апаратура',
    about: 'Форсунки, ТНВД, паливний насос — усе, що подає пальне в двигун.',
  },
  {
    key: 'timing',
    label: 'ГРМ',
    about: 'Ремінь або ланцюг ГРМ, ролики, помпа, натягувач.',
  },
  {
    key: 'maintenance',
    label: 'Обслуговування двигуна',
    about: 'Планове ТО по двигуну: масло, фільтри, свічки. ⚠️ Це не ремонт — у рекламній динаміці рахується окремо.',
  },
  {
    key: 'other',
    label: 'Інше по двигуну',
    about: 'Звернення стосується двигуна, але послуга не підпадає під жодну з категорій вище.',
  },
];

const REPAIR_SERVICES = ['overhaul', 'head', 'diagnostics', 'replacement', 'turbo', 'fuel', 'timing'];

const ENGINE_SERVICE_KEYS = ENGINE_SERVICES.map((s) => s.key);
const BY_KEY = new Map(ENGINE_SERVICES.map((s) => [s.key, s]));

const serviceLabel = (key) => BY_KEY.get(key)?.label || null;
const isRepairService = (key) => REPAIR_SERVICES.includes(key);

function mentionsEngine(text) {
  const low = String(text || '').toLowerCase();
  return ENGINE_WORDS.some((word) => low.includes(word));
}

function servicePromptList() {
  return ENGINE_SERVICES.map((s) => `- "${s.key}" — ${s.label}. ${s.about}`).join('\n');
}

export {
  ENGINE_WORDS,
  ENGINE_SERVICES,
  ENGINE_SERVICE_KEYS,
  REPAIR_SERVICES,
  mentionsEngine,
  serviceLabel,
  isRepairService,
  servicePromptList,
};
