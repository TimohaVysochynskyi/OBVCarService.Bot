import { findQuote } from './quoteMatch.js';

// Did the manager introduce himself? — one boolean per call, in TWO parts: did he give his NAME,
// and did he name the SERVICE ("OBVCarService"). The owner treats a missing introduction as a
// defect worth reporting, so it is counted, not judged.
//
// ⚠️ MEASURED ONLY ON PERSONAL EXTENSIONS (903/904/905), and that is not an arbitrary limit. On a
// shared handset (901/902) the introduction is what makes attribution possible at all: a call where
// nobody introduced themselves stays unattributed and already shows up as the "None" column of that
// line's breakdown. Counting it again here would double-report the same failure, and the calls that
// DID get attributed are, by construction, the ones where somebody introduced themselves — so a
// shared-line rate would be a tautology. The flag is still COMPUTED everywhere (it is free); only
// the reporting is restricted.
//
// ⚠️ THE COMPANY NAME IS UNRECOGNISABLE IN THE TRANSCRIPTS AND THAT DROVE THE WHOLE DESIGN.
// Measured over all 1910 stored calls: the "OBV" part comes back from speech-to-text in at least 25
// distinct spellings — АББ, АБВ, АВ, АВВ, БВ, ВБВ, ЛБВ, ОБЗ, ОДВ, ООО, Ви, ВіВі, Вікар, Авиви,
// Адама, Адікар, Аудіові, Одиги… Enumerating that is hopeless. What survives every one of those
// manglings is the SECOND half: "кар сервіс" / "кар сервис" / "карсервіс" / "карсервис". So the
// anchor is that phrase, and the OBV spellings are only a bonus signal.

// The reliable anchor plus the few prefix spellings worth catching on their own.
//
// ⚠️ `\b` is useless here. JavaScript's word boundary is ASCII-only, so `\bо` with a CYRILLIC "о"
// never matches — the pattern silently never fires. Every boundary below is spelled out with an
// explicit non-letter class under /u instead.
const EDGE = '(^|[^\\p{L}])';
const COMPANY_PATTERNS = [
  /кар\s*серв[іи]с/iu, // survives every mangling of the "OBV" prefix — the primary signal
  new RegExp(`${EDGE}obv([^\\p{L}]|$)`, 'iu'),
  new RegExp(`${EDGE}о\\s*б\\s*в([^\\p{L}]|$)`, 'iu'),
  new RegExp(`${EDGE}о[- ]?бі[- ]?ві([^\\p{L}]|$)`, 'iu'),
];

// First names as they are actually said, reduced to STEMS so one entry covers the declensions and
// the diminutives a real greeting uses ("Роман" / "Рома" / "Ромка"; "Андрій" / "Андрей" / "Андрюха").
// The canonical spelling is always added by nameStems() — this map only carries what a stem of the
// canonical name would MISS (a different root, like Володимир → Вова).
const EXTRA_STEMS = {
  Роман: ['рома', 'ромк'],
  Андрій: ['андр'],
  Володимир: ['волод', 'владим', 'вова', 'вовк'],
};

// Latin look-alikes are a real hazard here: speech-to-text mixes alphabets inside one word, so a
// Cyrillic "о" and a Latin "o" must compare equal or a greeting silently stops matching.
const LOOKALIKES = { a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у', b: 'в', k: 'к', m: 'м', t: 'т', h: 'н' };

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[a-z]/g, (ch) => LOOKALIKES[ch] || ch)
    .replace(/[ʼ’'`]/g, "'")
    .replace(/\s+/g, ' ');
}

// Stems to look for, given the canonical manager name. Short names are dropped: a 3-letter stem
// matches far too much ordinary speech to mean anything.
function nameStems(managerName) {
  const canonical = normalize(managerName).trim();
  if (canonical.length < 4) return [];
  // Drop the last two letters so the canonical form also covers its declensions (Романа, Андрієм).
  const stem = canonical.slice(0, Math.max(4, canonical.length - 2));
  const extra = (EXTRA_STEMS[String(managerName || '').trim()] || []).map(normalize);
  return [...new Set([stem, ...extra])];
}

// A stem counts only at a WORD START. Without that, "рома" matches "громадський" and every manager
// would look like he introduced himself.
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

// How much of the call to look at. An introduction is an OPENING act — by the fifth thing the
// manager says the conversation is already about the car, and any name in it belongs to the client
// or to a colleague, not to a self-introduction.
const INTRO_TURNS = 4;

// The manager's opening lines, from diarized segments when we have them and from the "Менеджер:"
// prefixes of a fallback transcript when we don't.
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

// Rule-based detection: {name, company}. This is the path for HISTORY — it costs nothing and gives
// the same answer on every re-run, so the time series can't quietly rewrite itself. New calls get
// the model's judgement instead (see INTRO_RULES), which reads phrasing this cannot.
//
// ⚠️ It reports PRESENCE of the name in the manager's opening lines, not grammatical self-reference.
// A manager greeting a client who happens to share his name reads as a false positive here; measured
// against the real data that is rare, and erring toward "he did introduce himself" keeps the code
// path from inflating the failure count it feeds.
function detectIntro({ segments, transcript, managerName }) {
  const lines = openingManagerLines(segments, transcript);
  if (!lines.length) return { name: false, company: false };
  // Matched against BOTH spellings, and that is not belt-and-braces. Folding Latin look-alikes into
  // Cyrillic rescues "Poмaн", but it also mangles genuinely Latin text: "OBV Car Service" would
  // become "овv саr sерviсе" and stop matching anything. Neither form alone covers both.
  const raw = lines.join(' ').toLowerCase();
  const stems = nameStems(managerName);
  return {
    name: hasStem(normalize(raw), stems) || hasStem(raw, stems),
    company: companyMatches(raw),
  };
}

// Tested against BOTH spellings for the reason above: the raw text catches genuine Latin, the folded
// text catches Cyrillic written with Latin look-alikes.
function companyMatches(text) {
  const raw = String(text || '').toLowerCase();
  const norm = normalize(raw);
  return COMPANY_PATTERNS.some((re) => re.test(raw) || re.test(norm));
}

// The model's answer, checked by CODE before it is believed — the same safeguard the refusal
// detector and the personal-call classifier use, and it is needed here for a measured reason.
//
// ⚠️ MEASURED ON LIVE CALLS: the first version asked only for two booleans, and the model returned
// name:true on EVERY call — including ones whose entire manager side was "Алло!" and "Да." The cause
// was the prompt itself: the user message opens with "Менеджер: Роман" as metadata, and the model
// read the name being present there as the name having been said. So a bare boolean cannot be
// trusted here; the model must now point at the LINE it heard, and that line is re-found in the
// call's own MANAGER segments. No line, or a line the manager never said, means false.
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
    // The name must actually be IN the quoted line. The model still decides the hard part — whether
    // it is self-reference or the manager addressing a client of the same name — but it can no
    // longer answer "yes" about a line that contains no name at all.
    name: check(raw?.name, raw?.nameQuote, (t) => hasStem(normalize(t), stems) || hasStem(t.toLowerCase(), stems)),
    // Deliberately laxer: recognising "Авивикар Сервис" as the company is the one thing the model
    // can do and the patterns cannot, so requiring a pattern match here would throw away the whole
    // point. "серв" is the fragment that survived every mangling we measured, so it is the floor.
    company: check(raw?.company, raw?.companyQuote, (t) => companyMatches(t) || /серв[іи]с/i.test(normalize(t))),
  };
}

// What the per-call model is told. Deliberately phrased around the SPEECH-TO-TEXT damage documented
// above: the model is the only one of the two paths that can recognise "Авивикар Сервис" as the
// company, and it will only do that if it is told to expect the mangling.
const INTRO_RULES = `⚠️ Рядок "Менеджер: <імʼя>" над транскриптом — це СЛУЖБОВА примітка від системи, а НЕ репліка. Те, що імʼя написане там, НЕ означає, що менеджер його вимовив. Суди ВИКЛЮЧНО за словами в самому транскрипті.
- intro.name = чи НАЗВАВ менеджер СВОЄ імʼя ("це Роман", "мене звати Андрій", "Володимир, добрий день"). Клієнтове імʼя чи імʼя колеги — НЕ рахується.
- intro.nameQuote = ДОСЛІВНИЙ рядок менеджера, у якому він назвався. Якщо такого рядка немає — intro.name = false і nameQuote = "".
- intro.companyQuote = ДОСЛІВНИЙ рядок менеджера, у якому звучить назва сервісу. Немає — intro.company = false і companyQuote = "".
- Обидві цитати СКОПІЮЙ дослівно з транскрипту. Вигадану цитату код відкине, і відповідь буде зарахована як "не представився".
- intro.company = чи назвав менеджер НАЗВУ СЕРВІСУ (OBVCarService — у розмові звучить як "ОБВ Кар Сервіс", "OBV Car Service").
  ⚠️ Розшифровка спотворює цю назву майже завжди. Реальні написання з наших дзвінків: "АБВ Кар Сервіс", "АВВ Кар Сервіс", "ВіВі Кар Сервіс", "Авивикар Сервис", "Адікар Сервіс", "Аудіовікар Сервіс", "ОДВ Карсервис", "Одигикар Сервис", "ЛБВ Карсервіс". Будь-яке таке спотворення, за яким упізнається "…кар сервіс", рахуй ЗА НАЗВУ СЕРВІСУ.
  ⚠️ АЛЕ якщо назву вимовила ІНША сторона (автовідповідач чужої компанії, клієнт) — це НЕ представлення менеджера.
- Обидва поля стосуються ПОЧАТКУ розмови — і на вхідному, і на вихідному дзвінку.`;

export { detectIntro, verifyIntro, INTRO_RULES, COMPANY_PATTERNS, companyMatches, nameStems, normalize, INTRO_TURNS };
