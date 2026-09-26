import { definePrompt } from './prompts.js';
import { findQuote } from './quoteMatch.js';


const EDGE = '(^|[^\\p{L}])';
const COMPANY_PATTERNS = [
  /кар[\s\-–—]*серв[іи]с/iu,
  new RegExp(`${EDGE}obv([^\\p{L}]|$)`, 'iu'),
  new RegExp(`${EDGE}о\\s*б\\s*в([^\\p{L}]|$)`, 'iu'),
  new RegExp(`${EDGE}о[- ]?бі[- ]?ві([^\\p{L}]|$)`, 'iu'),
];

const EXTRA_STEMS = {
  Роман: ['рома', 'ромк'],
  Андрій: ['андр'],
  Володимир: ['волод', 'владим', 'вова', 'вовк'],
};

const LOOKALIKES = { a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у', b: 'в', k: 'к', m: 'м', t: 'т', h: 'н' };

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[a-z]/g, (ch) => LOOKALIKES[ch] || ch)
    .replace(/[ʼ’'`]/g, "'")
    .replace(/\s+/g, ' ');
}

function nameStems(managerName) {
  const canonical = normalize(managerName).trim();
  if (canonical.length < 4) return [];
  const stem = canonical.slice(0, Math.max(4, canonical.length - 2));
  const extra = (EXTRA_STEMS[String(managerName || '').trim()] || []).map(normalize);
  return [...new Set([stem, ...extra])];
}

function isLetter(ch) {
  return /\p{L}/u.test(ch);
}

function hasStem(text, stems) {
  for (const s of stems) {
    if (!s) continue;
    for (let from = 0; ; ) {
      const at = text.indexOf(s, from);
      if (at < 0) break;
      if (at === 0 || !isLetter(text[at - 1])) return true;
      from = at + 1;
    }
  }
  return false;
}

const INTRO_TURNS = 4;

function openingManagerLines(segments, transcript) {
  if (Array.isArray(segments) && segments.length) {
    return segments.filter((s) => s?.role === 'manager').slice(0, INTRO_TURNS).map((s) => s.text || '');
  }
  const lines = String(transcript || '').split('\n');
  const out = [];
  for (const line of lines) {
    const m = /^\s*(Менеджер|Оператор)\s*:\s*(.*)$/i.exec(line);
    if (m) out.push(m[2]);
    if (out.length >= INTRO_TURNS) break;
  }
  return out;
}

function detectIntro({ segments, transcript, managerName }) {
  const lines = openingManagerLines(segments, transcript);
  if (!lines.length) return { name: false, company: false };
  const raw = lines.join(' ').toLowerCase();
  const stems = nameStems(managerName);
  return {
    name: hasStem(normalize(raw), stems) || hasStem(raw, stems),
    company: companyMatches(raw),
  };
}

function companyMatches(text) {
  const raw = String(text || '').toLowerCase();
  const norm = normalize(raw);
  return COMPANY_PATTERNS.some((re) => re.test(raw) || re.test(norm));
}

function verifyIntro(raw, segments, managerName) {
  const check = (claimed, quote, matches) => {
    if (claimed !== true) return false;
    const text = String(quote || '').trim();
    if (!text) return false;
    if (!findQuote(segments, text, { requireRole: 'manager' })) return false;
    return matches(text);
  };
  const stems = nameStems(managerName);
  return {
    name: check(raw?.name, raw?.nameQuote, (t) => hasStem(normalize(t), stems) || hasStem(t.toLowerCase(), stems)),
    company: check(raw?.company, raw?.companyQuote, (t) => companyMatches(t)),
  };
}

const introRules = definePrompt({
  key: 'intro',
  group: 'call',
  job: 'map',
  button: '🙋 Чи представився менеджер',
  title: '🙋 *Чи представився менеджер*',
  about:
    'Як AI вирішує, чи назвав менеджер своє імʼя та назву сервісу на початку розмови. ' +
    '⚠️ Сама перевірка (цитата має бути справжньою реплікою менеджера) забезпечується кодом і не редагується.',
});

export { detectIntro, verifyIntro, introRules, COMPANY_PATTERNS, companyMatches, nameStems, normalize, INTRO_TURNS };
