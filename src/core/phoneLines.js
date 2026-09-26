
const SHARED_EXTENSIONS = (process.env.SHARED_EXTENSIONS || '901,902')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_PERSONAL_OPERATORS = { 903: 'Роман', 904: 'Андрій', 905: 'Володимир' };

function parsePersonalOperators(raw) {
  const map = { ...DEFAULT_PERSONAL_OPERATORS };
  for (const pair of (raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key && val) map[key] = val;
  }
  return map;
}

const PERSONAL_OPERATORS = parsePersonalOperators(process.env.PERSONAL_OPERATORS);

const EXCLUDED_EXTENSIONS = (process.env.EXCLUDED_EXTENSIONS || '0674738200')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_LINE_NUMBERS = {
  901: '0754738200',
  902: '0774738200',
  903: '0734738200',
  904: '0504738201',
  905: '0674572011',
};

function parseLineNumbers(raw) {
  const map = { ...DEFAULT_LINE_NUMBERS };
  for (const pair of (raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).replace(/[^0-9+]/g, '').trim();
    if (key && val) map[key] = val;
  }
  return map;
}

const LINE_NUMBERS = parseLineNumbers(process.env.LINE_NUMBERS);

const LINE_KINDS = {
  shared: { title: 'Стаціонарний', about: 'Спільна лінія: слухавку бере той, хто вільний. Саме ці номери йдуть у рекламу, тому вхідні на них — головне, за чим тут варто стежити.' },
  personal: { title: 'Персональний', about: 'Особистий номер менеджера. Вихідні з нього — це дзвінки, які він робить сам.' },
  other: { title: 'Інший номер', about: 'Номер, якого немає ні серед стаціонарних, ні серед персональних.' },
  unknown: {
    title: 'None',
    about: 'Дзвінки на стаціонарні номери, у яких менеджер не представився, тож визначити його з розмови не вдалося. ⚠️ Це НЕ окрема лінія: ці дзвінки вже враховані в картках 901 і 902, тут вони зібрані окремо, щоб було видно обсяг.',
  },
};

const UNKNOWN_LINE = 'unknown';

function lineInfo(ext) {
  const number = String(ext ?? '').trim();
  const phone = LINE_NUMBERS[number] || null;
  if (SHARED_EXTENSIONS.includes(number)) return { number, kind: 'shared', name: null, phone };
  if (PERSONAL_OPERATORS[number]) return { number, kind: 'personal', name: PERSONAL_OPERATORS[number], phone };
  return { number, kind: 'other', name: null, phone };
}

export {
  SHARED_EXTENSIONS,
  PERSONAL_OPERATORS,
  EXCLUDED_EXTENSIONS,
  LINE_KINDS,
  LINE_NUMBERS,
  UNKNOWN_LINE,
  lineInfo,
  parsePersonalOperators,
};
