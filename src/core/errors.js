import { ACTIONS, CODES, UI } from './errorTexts.js';

// Розпізнавання помилок. Тут ЛОГІКА, у core/errorTexts.js — слова.
//
// Задача одна: перетворити будь-який виняток у (а) стабільний КОД класу, (б) повідомлення, яке
// зрозуміє директор СТО, і (в) технічний дамп для розробника. Раніше в Telegram летів сирий
// `err.message`, тобто або тіло відповіді OpenAI на 317 символів, або скарга нашого парсера
// («Unexpected token 'S'…»), з якої неможливо зрозуміти, що впало насправді.
//
// Реєстр замість розсипаних по коду рядків — той самий патерн, що `EDITABLE` в bot/prompt.js і
// `CATEGORIES` в bot/archive.js: додати клас помилки = один запис у CODES + один рядок у RULES.

// Помилка з уже відомим класом: кидається там, де код САМ знає, що сталося
// (непідтримуваний формат файлу, скан без тексту), тому вгадувати нічого не треба.
class AppError extends Error {
  constructor(code, { message, cause, ...rest } = {}) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    if (cause) this.cause = cause;
    Object.assign(this, rest);
  }
}

const appError = (code, opts) => new AppError(code, opts);

// HTTP-помилка зовнішнього сервісу. ЄДИНЕ місце, де читається тіло відповіді — і воно свідомо
// НЕ йде в err.message: message бачить людина, а тіло потрібне лише розпізнавачу й розробнику.
// Саме звідси беруться provider/status/body, на яких працюють правила нижче — тобто клас помилки
// визначається за полями, а не регулярками по вільному тексту.
async function httpError(provider, op, res) {
  let body = '';
  try {
    body = (await res.text()).slice(0, 4000);
  } catch {
    /* тіло вже прочитане або зʼєднання обірвалось - не критично */
  }
  const err = new Error(`${provider} ${op}: HTTP ${res.status}`);
  err.provider = provider;
  err.op = op;
  err.status = res.status;
  err.body = body;
  return err;
}

// Ідентифікатор інциденту: 4 символи без 0/O/1/I/L, щоб людина могла продиктувати його голосом
// або переписати з екрана без помилок. 32^4 ≈ мільйон - для дедупу в межах доби більш ніж досить.
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function incidentId() {
  let out = '';
  for (let i = 0; i < 4; i += 1) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return out;
}

// --- допоміжні предикати --------------------------------------------------------------------

const text = (err) =>
  [err?.message, err?.description, err?.body, err?.cause?.message].filter(Boolean).join(' ');

const has = (err, re) => re.test(text(err));

// Node/undici повідомляють про мережу через код у самій помилці або в err.cause (fetch завжди
// кидає TypeError('fetch failed'), а справжня причина лежить під cause).
const NET_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
  'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);
const netCode = (err) => err?.code || err?.cause?.code || null;
const isNet = (err) => NET_CODES.has(netCode(err)) || has(err, /fetch failed|socket hang up|network/i);
const isTimeout = (err) =>
  err?.name === 'AbortError' ||
  err?.name === 'TimeoutError' ||
  netCode(err) === 'ETIMEDOUT' ||
  netCode(err) === 'UND_ERR_HEADERS_TIMEOUT' ||
  has(err, /timed? ?out|ETIMEDOUT/i);

const from = (err, provider) => err?.provider === provider;
const status = (err, code) => err?.status === code || err?.error_code === code;
const status5xx = (err) => Number(err?.status || err?.error_code) >= 500;

// Telegram помилки приходять двома шляхами: наш власний fetch у core/telegram.js (тегований
// provider='telegram') і grammy, який кидає GrammyError/HttpError із власними полями.
const isTelegram = (err) =>
  from(err, 'telegram') || err?.name === 'GrammyError' || err?.name === 'HttpError';

// Postgres: SQLSTATE у err.code. Перевіряємо клас, а не текст - текст локалізований сервером.
const sqlState = (err) => (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null);
const isPgConn = (err) => {
  const s = sqlState(err);
  if (s && (s.startsWith('08') || s === '57P01' || s === '57P02' || s === '57P03')) return true;
  // До підключення справа може й не дійти: тоді це звичайна мережева помилка, але від pg-пулу.
  return NET_CODES.has(netCode(err)) && has(err, /postgres|5432|password|database/i);
};

// --- правила ---------------------------------------------------------------------------------
// Порядок ВАЖЛИВИЙ: перше влучання виграє, тож конкретне йде перед загальним. Кожне правило -
// чиста функція від помилки, тому весь цей блок перевіряється офлайн (див. tests у DEPLOY.md).
const RULES = [
  // Binotel
  ['BIN-DOWN', (e) => e?.binotelUnavailable === true],
  ['BIN-RATE', (e) => e?.binotelCode === 106 || (from(e, 'binotel') && has(e, /too frequent/i))],
  ['BIN-NODATA', (e) => e?.binotelCode === 104 || (from(e, 'binotel') && has(e, /wrong data/i))],
  // 121 — реальний код авторизації Binotel, зафіксований наживо 07.09 («Your key or secret is
  // wrong»). Текстова перевірка лишається як запас на випадок інших формулювань.
  ['BIN-AUTH', (e) => from(e, 'binotel') && (e?.binotelCode === 121 || status(e, 401) || status(e, 403) || has(e, /key or secret|wrong (api )?key|invalid key|access denied|not authorized/i))],
  ['BIN-DL-403', (e) => from(e, 'recording') && (status(e, 403) || status(e, 401))],
  ['BIN-DL-5XX', (e) => from(e, 'recording') && status5xx(e)],
  ['BIN-TIMEOUT', (e) => (from(e, 'binotel') || from(e, 'recording')) && isTimeout(e)],
  ['BIN-NET', (e) => (from(e, 'binotel') || from(e, 'recording')) && isNet(e)],

  // OpenAI
  ['OAI-QUOTA', (e) => from(e, 'openai') && has(e, /insufficient_quota|credit_balance_exhausted|no credits remaining/i)],
  ['OAI-RATE', (e) => from(e, 'openai') && status(e, 429)],
  ['OAI-AUTH', (e) => from(e, 'openai') && (status(e, 401) || status(e, 403))],
  ['OAI-MODEL', (e) => from(e, 'openai') && has(e, /model_not_found|does not exist.*model|deprecated/i)],
  ['OAI-CTXLEN', (e) => from(e, 'openai') && has(e, /context_length_exceeded|maximum context length/i)],
  ['OAI-5XX', (e) => from(e, 'openai') && status5xx(e)],
  ['OAI-TIMEOUT', (e) => from(e, 'openai') && isTimeout(e)],
  ['OAI-NET', (e) => from(e, 'openai') && isNet(e)],
  // Єдиний JSON, який ми розбираємо з відповіді моделі - тому SyntaxError про JSON це вона.
  ['OAI-BADJSON', (e) => e?.name === 'SyntaxError' && has(e, /JSON/i)],

  // ElevenLabs
  ['ELV-NOKEY', (e) => has(e, /ELEVENLABS_API_KEY is not set/i)],
  ['ELV-QUOTA', (e) => from(e, 'elevenlabs') && has(e, /quota|credit|insufficient|payment/i)],
  ['ELV-AUTH', (e) => from(e, 'elevenlabs') && (status(e, 401) || status(e, 403))],
  ['ELV-RATE', (e) => from(e, 'elevenlabs') && status(e, 429)],
  ['ELV-5XX', (e) => from(e, 'elevenlabs') && status5xx(e)],
  ['ELV-TIMEOUT', (e) => from(e, 'elevenlabs') && isTimeout(e)],
  ['ELV-NET', (e) => from(e, 'elevenlabs') && isNet(e)],

  // Telegram
  ['TG-403', (e) => isTelegram(e) && (status(e, 403) || has(e, /bot was blocked|user is deactivated|chat not found/i))],
  ['TG-429', (e) => isTelegram(e) && status(e, 429)],
  ['TG-OLDQUERY', (e) => isTelegram(e) && has(e, /query is too old|query ID is invalid/i)],
  ['TG-ENTITY', (e) => isTelegram(e) && has(e, /can'?t parse entities|can not parse entities|unsupported start tag/i)],
  ['TG-TOOLONG', (e) => isTelegram(e) && has(e, /message is too long|text is too long/i)],
  ['TG-CBDATA', (e) => isTelegram(e) && has(e, /BUTTON_DATA_INVALID|callback_data/i)],
  ['TG-FILESIZE', (e) => isTelegram(e) && has(e, /file is too big|request entity too large/i)],
  ['TG-5XX', (e) => isTelegram(e) && status5xx(e)],
  ['TG-NET', (e) => isTelegram(e) && (isNet(e) || isTimeout(e))],

  // Postgres
  ['DB-NOVECTOR', (e) => has(e, /extension "?vector"?|type "?vector"?/i)],
  ['DB-MAXCONN', (e) => sqlState(e) === '53300' || sqlState(e) === '53400' || has(e, /too many clients|too many connections/i)],
  ['DB-DISK', (e) => sqlState(e) === '53100' || has(e, /no space left|disk full/i)],
  ['DB-TIMEOUT', (e) => sqlState(e) === '57014' || sqlState(e) === '55P03' || sqlState(e) === '40P01'],
  ['DB-CONN', isPgConn],

  // Сервер і зовнішні програми
  ['FFM-MISSING', (e) => netCode(e) === 'ENOENT' && has(e, /ffmpeg|ffprobe/i)],
  ['FFM-TIMEOUT', (e) => has(e, /ffmpeg/i) && isTimeout(e)],
  ['FFM-FAIL', (e) => has(e, /ffmpeg exit/i)],
  ['SYS-DISK', (e) => netCode(e) === 'ENOSPC'],

  // Файли бази знань
  ['PDF-ENCRYPTED', (e) => has(e, /encrypted|password/i) && has(e, /pdf/i)],
  ['PDF-CORRUPT', (e) => has(e, /no pdf header|failed to parse pdf|invalid pdf|corrupt/i)],

  // Загальні - лишаються в кінці, щоб не перехоплювати конкретні класи вище
  ['TIMEOUT', isTimeout],
  ['NET', isNet],
];

// Код класу помилки. Стабільний: клієнт бачить його в повідомленні, розробник шукає за ним у логах.
function classify(err) {
  if (err?.code && CODES[err.code]) return err.code; // AppError - клас відомий на місці кидання
  for (const [code, matches] of RULES) {
    try {
      if (matches(err)) return code;
    } catch {
      /* жодне правило не має права зламати розпізнавання */
    }
  }
  return 'UNKNOWN';
}

// Класи, яких повтор НЕ виправить: сюда дивиться черга ретраю в jobs/processCalls.js, щоб не
// спалювати 20 спроб на дзвінку, який і на 20-й раз впаде так само.
const PERMANENT = new Set([
  'BIN-NODATA', 'BIN-AUTH', 'OAI-CTXLEN', 'OAI-MODEL', 'OAI-AUTH', 'OAI-QUOTA',
  'ELV-NOKEY', 'FFM-MISSING', 'DB-NOVECTOR', 'TG-CBDATA', 'TG-TOOLONG', 'TG-ENTITY',
  'TG-FILESIZE', 'FMT-UNSUP', 'PDF-SCANNED', 'PDF-ENCRYPTED', 'PDF-CORRUPT', 'SYS-NOFILE',
]);
const isPermanent = (code) => PERMANENT.has(code);

// Клас помилки, ЯКИЙ ЦЕЙ КОНКРЕТНИЙ ДЗВІНОК не переживе ніколи: повтор нічого не змінить не
// тому, що потрібне втручання, а тому, що вхідні дані такі, які вони є. Вужче за PERMANENT: там,
// наприклад, OAI-QUOTA (після поповнення повтор ЯК РАЗ допоможе), тут його бути не може.
// Дивиться сюда черга ретраю - щоб не палити 20 спроб на дзвінку, який і на 20-й впаде так само.
const HOPELESS = new Set(['OAI-CTXLEN', 'SYS-NOFILE', 'FMT-UNSUP', 'PDF-SCANNED', 'PDF-ENCRYPTED', 'PDF-CORRUPT']);
const isHopeless = (code) => HOPELESS.has(code);

// Відновити клас помилки з РЯДКА, збереженого раніше (pending_calls.last_error). Поля provider/
// status губляться при записі в базу, але httpError пише message у стабільній формі
// "<сервіс> <операція>: HTTP <код>" - звідси їх можна дістати назад. Без цього кожна помилка з
// черги ретраю визначалась би як UNKNOWN, і алерт про здачу дзвінка не сказав би нічого.
function reviveError(storedText) {
  const err = new Error(String(storedText || '').trim() || 'невідома помилка');
  const m = /^([a-z]+) (.+): HTTP ([0-9]{3})$/i.exec(err.message);
  if (m) {
    err.provider = m[1].toLowerCase();
    err.op = m[2];
    err.status = Number(m[3]);
  }
  return err;
}

// Технічний дамп: усе, що потрібно розробнику, і ніщо з цього не показується клієнту без запиту.
function technicalOf(err) {
  const lines = [];
  if (err?.provider) lines.push(`сервіс: ${err.provider}${err.op ? ` (${err.op})` : ''}`);
  if (err?.status != null) lines.push(`HTTP: ${err.status}`);
  if (err?.error_code != null) lines.push(`Telegram: ${err.error_code}`);
  if (err?.binotelCode != null) lines.push(`Binotel: ${err.binotelCode}`);
  if (sqlState(err)) lines.push(`SQLSTATE: ${err.code}`);
  else if (netCode(err)) lines.push(`код: ${netCode(err)}`);
  lines.push(`${err?.name || 'Error'}: ${err?.message || String(err)}`);
  if (err?.description) lines.push(`опис: ${err.description}`);
  if (err?.body) lines.push(`тіло відповіді: ${String(err.body).slice(0, 1200)}`);
  if (err?.cause?.message && err.cause.message !== err.message) lines.push(`причина: ${err.cause.message}`);
  if (err?.stack) lines.push(String(err.stack).split('\n').slice(1, 5).join('\n'));
  return lines.join('\n');
}

// Один рядок технічного для алертів інжесту: там кнопки «Деталі» не буде, бо cron-процес
// завершується одразу після надсилання (повний дамп ляже в журнал інцидентів - Фаза 3).
function technicalLineOf(err) {
  const msg = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
  // Додаємо лише те, чого в message ще немає: httpError уже пише туди "<сервіс> <операція>:
  // HTTP <код>", і без цієї перевірки рядок виходив як "binotel HTTP 200 — binotel …: HTTP 200".
  const extra = [];
  if (err?.provider && !msg.startsWith(err.provider)) extra.push(err.provider);
  if (err?.status != null && !msg.includes(`HTTP ${err.status}`)) extra.push(`HTTP ${err.status}`);
  if (err?.error_code != null) extra.push(`Telegram ${err.error_code}`);
  if (err?.binotelCode != null && !msg.includes(String(err.binotelCode))) extra.push(`код ${err.binotelCode}`);
  if (sqlState(err)) extra.push(err.code);
  else if (netCode(err) && !msg.includes(netCode(err))) extra.push(netCode(err));
  const head = extra.length ? `${extra.join(' ')} — ` : '';
  return `${head}${msg}`.slice(0, 220);
}

// Головна функція: виняток -> усе, що потрібно для показу.
//   action — ключ із ACTIONS (яка саме дія не вдалася); невідомий ключ падає на 'fallback'.
//   icon   — те, з чого починається перший рядок.
// Повертає { code, incident, text, technical, technicalLine, permanent }.
function describeError(
  err,
  { action = 'fallback', icon = '❌', incident = incidentId(), subject = null, title = null, data = null, advice = null } = {}
) {
  const code = classify(err);
  const t = CODES[code] || CODES.UNKNOWN;
  const entry = ACTIONS[action] || ACTIONS.fallback;
  const heading = title || (typeof entry === 'function' ? entry(subject) : entry);

  // Порада, як і рядок про дані, перевизначається тим, хто кидає: класова («наступний прогін
  // повторить») суперечила б, наприклад, заголовку «дзвінок не оброблено після 20 спроб».
  const parts = [`${icon} ${heading}`, '', t.cause, '', `${UI.whatToDo} ${advice ?? t.action}`];
  // Рядок про дані бере верх над тим, що в каталозі: каталог описує КЛАС помилки, а той, хто
  // кидає, іноді знає про долю даних більше (напр. дзвінок здали після 20 спроб - тоді «збережено
  // без оцінки» з каталогу було б неправдою).
  const dataLine = data ?? t.data;
  if (dataLine) parts.push(dataLine);
  parts.push('', UI.codeLine(code, incident));

  return {
    code,
    incident,
    text: parts.join('\n'),
    technical: technicalOf(err),
    technicalLine: technicalLineOf(err),
    permanent: isPermanent(code),
  };
}

export {
  AppError,
  appError,
  httpError,
  incidentId,
  classify,
  describeError,
  technicalOf,
  technicalLineOf,
  isPermanent,
  isHopeless,
  reviveError,
  RULES,
};
