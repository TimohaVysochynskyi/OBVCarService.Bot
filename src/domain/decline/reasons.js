const DECLINE_REASONS = [
  { key: 'busy', side: 'service', bucket: 'no_slot', label: 'Зайнято, немає вільного часу' },
  { key: 'queue', side: 'service', bucket: 'no_slot', label: 'Черга на кілька днів' },
  { key: 'no_master', side: 'service', bucket: 'no_slot', label: 'Немає потрібного майстра' },
  { key: 'no_part', side: 'service', bucket: 'no_parts', label: 'Немає потрібної деталі' },
  { key: 'part_wait', side: 'service', bucket: 'no_parts', label: 'Деталь треба довго чекати' },
  { key: 'not_our_car', side: 'service', bucket: 'out_of_scope', label: 'Не працюємо з таким авто' },
  { key: 'no_service', side: 'service', bucket: 'out_of_scope', label: 'Такої послуги не надаємо' },
  { key: 'no_equipment', side: 'service', bucket: 'out_of_scope', label: 'Немає потрібного обладнання' },

  { key: 'price', side: 'client', bucket: null, label: 'Не влаштувала ціна' },
  { key: 'thinking', side: 'client', bucket: null, label: 'Подумає, передзвонить' },
  { key: 'competitor', side: 'client', bucket: null, label: 'Поїхав до інших' },
  { key: 'timing', side: 'client', bucket: null, label: 'Не влаштував запропонований час' },
  { key: 'diy', side: 'client', bucket: null, label: 'Вирішив робити сам' },
  { key: 'just_asking', side: 'client', bucket: null, label: 'Дзвонив лише дізнатись ціну' },
  { key: 'no_answer', side: 'client', bucket: null, label: 'Розмова обірвалась без рішення' },
  { key: 'unclear', side: 'client', bucket: null, label: 'Причина не прозвучала' },
];

const BY_KEY = new Map(DECLINE_REASONS.map((r) => [r.key, r]));

const SERVICE_REASONS = DECLINE_REASONS.filter((r) => r.side === 'service');
const CLIENT_REASONS = DECLINE_REASONS.filter((r) => r.side === 'client');

const SERVICE_REASON_KEYS = SERVICE_REASONS.map((r) => r.key);
const CLIENT_REASON_KEYS = CLIENT_REASONS.map((r) => r.key);

const reasonLabel = (key) => BY_KEY.get(key)?.label || null;
const reasonSide = (key) => BY_KEY.get(key)?.side || null;
const bucketOfReason = (key) => BY_KEY.get(key)?.bucket || null;
const reasonsOfBucket = (bucket) => SERVICE_REASONS.filter((r) => r.bucket === bucket);

function reasonPromptList(reasons) {
  return reasons.map((r) => `- "${r.key}" — ${r.label}`).join('\n');
}

export {
  DECLINE_REASONS,
  SERVICE_REASONS,
  CLIENT_REASONS,
  SERVICE_REASON_KEYS,
  CLIENT_REASON_KEYS,
  reasonLabel,
  reasonSide,
  bucketOfReason,
  reasonsOfBucket,
  reasonPromptList,
};
