import { ACTIONS, CODES, UI } from './errorTexts.js';


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

async function httpError(provider, op, res) {
  let body = '';
  try {
    body = (await res.text()).slice(0, 4000);
  } catch {
  }
  const err = new Error(`${provider} ${op}: HTTP ${res.status}`);
  err.provider = provider;
  err.op = op;
  err.status = res.status;
  err.body = body;
  const hinted = retryAfterMs(res, body);
  if (hinted != null) err.retryAfterMs = hinted;
  return err;
}

const MAX_RETRY_AFTER_MS = 60_000;

function retryAfterMs(res, body) {
  const header = res?.headers?.get?.('retry-after') ?? res?.headers?.get?.('x-ratelimit-reset-tokens');
  if (header) {
    const value = String(header).trim();
    const seconds = value.endsWith('ms') ? Number(value.slice(0, -2)) / 1000 : Number(value.replace(/s$/, ''));
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const match = /try again in ([\d.]+)\s*(ms|s)/i.exec(body || '');
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) {
      const ms = match[2].toLowerCase() === 'ms' ? value : value * 1000;
      return Math.min(ms, MAX_RETRY_AFTER_MS);
    }
  }
  return null;
}

const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function incidentId() {
  let out = '';
  for (let i = 0; i < 4; i += 1) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return out;
}


const text = (err) =>
  [err?.message, err?.description, err?.body, err?.cause?.message].filter(Boolean).join(' ');

const has = (err, re) => re.test(text(err));

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

const isTelegram = (err) =>
  from(err, 'telegram') || err?.name === 'GrammyError' || err?.name === 'HttpError';

const sqlState = (err) => (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null);
const isPgConn = (err) => {
  const s = sqlState(err);
  if (s && (s.startsWith('08') || s === '57P01' || s === '57P02' || s === '57P03')) return true;
  return NET_CODES.has(netCode(err)) && has(err, /postgres|5432|password|database/i);
};

const RULES = [
  ['BIN-DOWN', (e) => e?.binotelUnavailable === true],
  ['BIN-RATE', (e) => e?.binotelCode === 106 || (from(e, 'binotel') && has(e, /too frequent/i))],
  ['BIN-NODATA', (e) => e?.binotelCode === 104 || (from(e, 'binotel') && has(e, /wrong data/i))],
  ['BIN-AUTH', (e) => from(e, 'binotel') && (e?.binotelCode === 121 || status(e, 401) || status(e, 403) || has(e, /key or secret|wrong (api )?key|invalid key|access denied|not authorized/i))],
  ['BIN-DL-403', (e) => from(e, 'recording') && (status(e, 403) || status(e, 401))],
  ['BIN-DL-5XX', (e) => from(e, 'recording') && status5xx(e)],
  ['BIN-TIMEOUT', (e) => (from(e, 'binotel') || from(e, 'recording')) && isTimeout(e)],
  ['BIN-NET', (e) => (from(e, 'binotel') || from(e, 'recording')) && isNet(e)],

  ['OAI-QUOTA', (e) => from(e, 'openai') && has(e, /insufficient_quota|credit_balance_exhausted|no credits remaining/i)],
  ['OAI-RATE', (e) => from(e, 'openai') && status(e, 429)],
  ['OAI-AUTH', (e) => from(e, 'openai') && (status(e, 401) || status(e, 403))],
  ['OAI-MODEL', (e) => from(e, 'openai') && has(e, /model_not_found|does not exist.*model|deprecated/i)],
  ['OAI-CTXLEN', (e) => from(e, 'openai') && has(e, /context_length_exceeded|maximum context length/i)],
  ['OAI-5XX', (e) => from(e, 'openai') && status5xx(e)],
  ['OAI-TIMEOUT', (e) => from(e, 'openai') && isTimeout(e)],
  ['OAI-NET', (e) => from(e, 'openai') && isNet(e)],
  ['OAI-BADJSON', (e) => e?.name === 'SyntaxError' && has(e, /JSON/i)],

  ['ELV-NOKEY', (e) => has(e, /ELEVENLABS_API_KEY is not set/i)],
  ['ELV-QUOTA', (e) => from(e, 'elevenlabs') && has(e, /quota|credit|insufficient|payment/i)],
  ['ELV-AUTH', (e) => from(e, 'elevenlabs') && (status(e, 401) || status(e, 403))],
  ['ELV-RATE', (e) => from(e, 'elevenlabs') && status(e, 429)],
  ['ELV-5XX', (e) => from(e, 'elevenlabs') && status5xx(e)],
  ['ELV-TIMEOUT', (e) => from(e, 'elevenlabs') && isTimeout(e)],
  ['ELV-NET', (e) => from(e, 'elevenlabs') && isNet(e)],

  ['TG-403', (e) => isTelegram(e) && (status(e, 403) || has(e, /bot was blocked|user is deactivated|chat not found/i))],
  ['TG-429', (e) => isTelegram(e) && status(e, 429)],
  ['TG-OLDQUERY', (e) => isTelegram(e) && has(e, /query is too old|query ID is invalid/i)],
  ['TG-ENTITY', (e) => isTelegram(e) && has(e, /can'?t parse entities|can not parse entities|unsupported start tag/i)],
  ['TG-TOOLONG', (e) => isTelegram(e) && has(e, /message is too long|text is too long/i)],
  ['TG-CBDATA', (e) => isTelegram(e) && has(e, /BUTTON_DATA_INVALID|callback_data/i)],
  ['TG-FILESIZE', (e) => isTelegram(e) && has(e, /file is too big|request entity too large/i)],
  ['TG-409', (e) => isTelegram(e) && has(e, /conflict|terminated by other getupdates|another instance/i)],
  ['TG-5XX', (e) => isTelegram(e) && status5xx(e)],
  ['TG-NET', (e) => isTelegram(e) && (isNet(e) || isTimeout(e))],

  ['DB-NOVECTOR', (e) => has(e, /extension "?vector"?|type "?vector"?/i)],
  ['DB-MAXCONN', (e) => sqlState(e) === '53300' || sqlState(e) === '53400' || has(e, /too many clients|too many connections/i)],
  ['DB-DISK', (e) => sqlState(e) === '53100' || has(e, /no space left|disk full/i)],
  ['DB-TIMEOUT', (e) => sqlState(e) === '57014' || sqlState(e) === '55P03' || sqlState(e) === '40P01'],
  ['DB-CONN', isPgConn],

  ['FFM-MISSING', (e) => netCode(e) === 'ENOENT' && has(e, /ffmpeg|ffprobe/i)],
  ['FFM-TIMEOUT', (e) => has(e, /ffmpeg/i) && isTimeout(e)],
  ['FFM-FAIL', (e) => has(e, /ffmpeg exit/i)],
  ['SYS-DISK', (e) => netCode(e) === 'ENOSPC'],

  ['PDF-ENCRYPTED', (e) => has(e, /encrypted|password/i) && has(e, /pdf/i)],
  ['PDF-CORRUPT', (e) => has(e, /no pdf header|failed to parse pdf|invalid pdf|corrupt/i)],

  ['TIMEOUT', isTimeout],
  ['NET', isNet],
];

function classify(err) {
  if (err?.code && CODES[err.code]) return err.code;
  for (const [code, matches] of RULES) {
    try {
      if (matches(err)) return code;
    } catch {
    }
  }
  return 'UNKNOWN';
}

const PERMANENT = new Set([
  'BIN-NODATA', 'BIN-AUTH', 'OAI-CTXLEN', 'OAI-MODEL', 'OAI-AUTH', 'OAI-QUOTA',
  'ELV-NOKEY', 'FFM-MISSING', 'DB-NOVECTOR', 'TG-CBDATA', 'TG-TOOLONG', 'TG-ENTITY',
  'TG-FILESIZE', 'FMT-UNSUP', 'PDF-SCANNED', 'PDF-ENCRYPTED', 'PDF-CORRUPT', 'SYS-NOFILE',
]);
const isPermanent = (code) => PERMANENT.has(code);

function modelContent(data, provider, op) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  const err = new Error(`${provider} ${op}: модель повернула порожню відповідь`);
  err.provider = provider;
  err.op = op;
  err.code = 'OAI-BADJSON';
  try {
    err.body = JSON.stringify(data ?? null).slice(0, 1000);
  } catch {
    err.body = '(відповідь не серіалізується)';
  }
  throw err;
}

function parseModelJson(data, provider, op) {
  const content = modelContent(data, provider, op);
  try {
    return JSON.parse(content);
  } catch (cause) {
    const err = new Error(`${provider} ${op}: відповідь моделі не є валідним JSON`);
    err.provider = provider;
    err.op = op;
    err.code = 'OAI-BADJSON';
    err.body = content.slice(0, 1000);
    err.cause = cause;
    throw err;
  }
}

const HOPELESS = new Set(['OAI-CTXLEN', 'SYS-NOFILE', 'FMT-UNSUP', 'PDF-SCANNED', 'PDF-ENCRYPTED', 'PDF-CORRUPT']);
const isHopeless = (code) => HOPELESS.has(code);

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

function technicalLineOf(err) {
  const msg = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
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

function describeError(
  err,
  { action = 'fallback', icon = '❌', incident = incidentId(), subject = null, title = null, data = null, advice = null } = {}
) {
  const code = classify(err);
  const t = CODES[code] || CODES.UNKNOWN;
  const entry = ACTIONS[action] || ACTIONS.fallback;
  const heading = title || (typeof entry === 'function' ? entry(subject) : entry);

  const parts = [`${icon} ${heading}`, '', t.cause, '', `${UI.whatToDo} ${advice ?? t.action}`];
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
  modelContent,
  parseModelJson,
  reviveError,
  RULES,
};
