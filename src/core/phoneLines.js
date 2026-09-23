// Which internal number is what. The ingest needs this to attribute a call to a manager; the
// published report needs it to label the five lines. Keeping one definition matters more here than
// usual: if the two ever disagreed, a call would be counted under a line the report calls something
// else, and nobody would notice.

// Extensions physically shared between operators (a common handset), where Binotel cannot tell us
// who answered — the operator is identified from the recording instead (see identifyManager).
// The owner calls these "стаціонарні": they are the numbers that go on advertising.
const SHARED_EXTENSIONS = (process.env.SHARED_EXTENSIONS || '901,902')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Personal extensions are identified by NUMBER, not by whatever name Binotel's employeeData
// currently reports. That name has been observed to (a) go briefly empty, which used to fall
// through to content-based identification and sometimes misattribute the call to a DIFFERENT
// manager, and (b) change spelling (a RU→UK rename in the Binotel dashboard), which would split one
// person's history into two manager_name buckets. The extension number is the stable identifier, so
// it is the source of truth for which of OUR canonical names a personal-extension call belongs to.
// Format: "ext=Name,ext=Name" via env, merged over the default.
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

// Extensions skipped entirely — never transcribed, analyzed or saved. For a number that is not a
// salesperson's line (the director's personal mobile), Binotel carries no employeeData, so it used
// to fall through to content-based identification and could misattribute calls to a real manager by
// voice alone, polluting their stats.
const EXCLUDED_EXTENSIONS = (process.env.EXCLUDED_EXTENSIONS || '0674738200')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// The real phone number behind each extension. Binotel does NOT give this: its per-call
// `pbxNumberData` is the SIM the call went THROUGH, which for a personal extension happens to equal
// its own number, but for the shared lines is whichever number the client dialled — measured over
// ~350 calls, 901 was seen on 0734738200 and 0674572011, never on its own. So the mapping is
// configuration, like PERSONAL_OPERATORS, and for the same reason: it must not drift with traffic.
// Format: "ext=number,ext=number" via env, merged over the default.
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
};

// What a given extension is, for labelling. Never throws and never guesses: a number we have no
// configuration for is reported as such rather than silently folded into one of the known kinds.
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
  lineInfo,
  parsePersonalOperators,
};
