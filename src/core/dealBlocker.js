import { withRetry } from './retry.js';
import { definePrompt } from './prompts.js';
import { parseModelJson } from './errors.js';
import { fetchOk } from './http.js';
import { findQuote } from './quoteMatch.js';
import { pseudoSegments } from './analyzeCall.js';
import { SERVICE_REASON_KEYS, bucketOfReason, reasonsOfBucket, reasonPromptList } from './declineReasons.js';

// "Незакриті угоди" — a deal that did NOT close for a reason that is NOT the manager's fault: the
// СТО itself could not take the job. Without this, every such call counted as a failed deal and
// dragged the manager's conversion down for something he could not sell.
//
// EXACTLY TWO categories (owner's decision 2026-07-30) — they are also the two dynamics columns:
//   • no_slot      («Черга»)   — no free time/slot: fully booked, queue, no lift free, not this week
//   • out_of_scope («Профіль») — the СТО does not provide it at all: wrong type of car, service not
//                                offered, no equipment/specialist, the needed part is unobtainable
//
// Reliability follows the same rule as the rest of the analysis: the model must return a VERBATIM
// MANAGER line, and CODE re-locates it in the call's segments (findQuote, requireRole:'manager').
// A quote that cannot be located means the blocker is dropped — so a hallucinated or paraphrased
// "СТО was full" can never reach the report or the counters.
//
// Model: OPENAI_BLOCKER_MODEL, default gpt-4o (NOT the cheap mini used elsewhere) — the owner asked
// for maximum accuracy here, and the volume makes it irrelevant: this runs only on calls that did
// not close (~19/day live, 766 rows for the whole history), on ~850-character transcripts.

const NO_BLOCKER = 'none';
const DEAL_BLOCKERS = ['no_slot', 'no_parts', 'out_of_scope'];

// Full wording for the report; SHORT wording for the dynamics table columns (must stay narrow so the
// 6-column table still fits a phone screen).
const BLOCKER_LABELS = {
  no_slot: 'Черга — немає вільного місця/часу',
  no_parts: 'Нема деталей — потрібну запчастину не дістати',
  out_of_scope: 'Не обслуговуємо — такої послуги/таких авто не беремо',
};
const BLOCKER_COLUMNS = { no_slot: 'Черга', no_parts: 'Деталі', out_of_scope: 'Не наш профіль' };
const BLOCKER_TITLES = {
  no_slot: 'Немає вільного місця',
  no_parts: 'Відсутність деталей',
  out_of_scope: 'Не наш профіль',
};

const model = () => process.env.OPENAI_BLOCKER_MODEL || 'gpt-4o';

const REASON_SECTION = DEAL_BLOCKERS.map(
  (b) => `  ${BLOCKER_COLUMNS[b]} (${b}):
${reasonPromptList(reasonsOfBucket(b)).replace(/^/gm, '  ')}`
).join(`
`);

const SCHEMA = {
  name: 'deal_blocker',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      blocker: { type: 'string', enum: [...DEAL_BLOCKERS, NO_BLOCKER] },
      reason: { type: 'string', enum: ['', ...SERVICE_REASON_KEYS] },
      quote: { type: 'string' },
    },
    required: ['blocker', 'reason', 'quote'],
    additionalProperties: false,
  },
};

// Second, ADVERSARIAL pass. Measured on live data the base rate of a real blocker is tiny (roughly
// 2-4 calls in six weeks), so precision dominates: at even a 5% false-positive rate a single pass
// over the history would invent dozens of blockers, drown the few real ones and — because blocked
// calls leave the conversion denominator — silently flatter every manager. The detector alone was
// measured producing ~1 false positive in 3 (a manager musing "someone who knows should look at the
// wiring" was read as a refusal), so a strict reviewer that DEFAULTS TO REJECT is what makes the
// number trustworthy. Same shape as the findings relevance pass in bot/analyze.js.
const blockerPrompt = definePrompt({
  key: 'blocker',
  group: 'call',
  job: 'blocker',
  button: '🚧 Відмови СТО — пошук',
  title: '🚧 *Відмови СТО — пошук*',
  about:
    'Як AI шукає дзвінки, де клієнта не взяло САМЕ СТО (черга, немає деталі, не наш профіль). ' +
    'Такі дзвінки виключаються зі знаменника конверсії, щоб менеджера не карали за чужу проблему.',
});

const blockerReviewPrompt = definePrompt({
  key: 'blockerReview',
  group: 'call',
  job: 'blocker',
  button: '🚧 Відмови СТО — перевірка',
  title: '🚧 *Відмови СТО — перевірка*',
  about:
    'Другий, суворий прохід: він ВІДКИДАЄ знахідку, якщо вона не доведена. ' +
    '⚠️ Саме він тримає точність — без нього приблизно кожна третя знахідка була хибною.',
});


const VERIFY_SCHEMA = {
  name: 'blocker_verdict',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      confirmed: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['confirmed', 'reason'],
    additionalProperties: false,
  },
};

async function verifyBlocker(transcript, blocker, quote) {
  const res = await fetchOk('openai', 'перевірка незакритої угоди', 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model(),
      messages: [
        { role: 'system', content: await blockerReviewPrompt() },
        {
          role: 'user',
          content:
            `Твердження: ${BLOCKER_LABELS[blocker]}\nЦитата менеджера: «${quote}»\n\nПовна розмова:\n${transcript}`,
        },
      ],
      temperature: 0, // same reason as the detector: the verdict must be reproducible
      response_format: { type: 'json_schema', json_schema: VERIFY_SCHEMA },
    }),
  });
  return parseModelJson(await res.json(), 'openai', 'перевірка незакритої угоди');
}

// The model sometimes copies the transcript line WITH its role label ("Менеджер: ..."). Strip it so
// the stored quote reads cleanly in the report (and matches the segment text, which has no label).
function stripRoleLabel(quote) {
  return quote.replace(/^\s*(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*/i, '').trim();
}

// Returns { blocker: 'no_slot'|'out_of_scope'|'none', quote, start, end }.
// 'none' is returned for anything unclear, and ALSO whenever the model's quote cannot be located in a
// manager segment — the counters and the report must never rest on an unverifiable claim.
async function detectDealBlocker(transcript, segments, managerName) {
  const verifySegments = Array.isArray(segments) && segments.length ? segments : pseudoSegments(transcript);
  if (!transcript || !verifySegments.length) return { blocker: NO_BLOCKER, reason: null, quote: null, start: null, end: null };

  const raw = await withRetry(
    async () => {
      const res = await fetchOk('openai', 'пошук незакритої угоди', 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model(),
          messages: [
            { role: 'system', content: await blockerPrompt() },
            {
              role: 'user',
              content: `${managerName ? `Менеджер: ${managerName}\n\n` : ''}Транскрипт:\n${transcript}`,
            },
          ],
          // Pinned to 0: this is a COUNTED metric feeding the growth time series, so re-running the
          // backfill must reproduce the same numbers. Observed at the default temperature: the same
          // call flipped between 'none' and a blocker across runs, which would silently rewrite
          // history. (The rest of the project's LLM calls still use the default - they produce prose,
          // not counters, so changing those is a separate decision.)
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      return parseModelJson(await res.json(), 'openai', 'пошук незакритої угоди');
    },
    // gpt-4o on this account has a 30k tokens/min cap and the report reduce uses the same model, so
    // 429s are expected under load - back off longer and try more often than the mini-model callers.
    { attempts: 4, delayMs: 4000, label: 'OpenAI deal blocker' }
  );

  const blocker = DEAL_BLOCKERS.includes(raw.blocker) ? raw.blocker : NO_BLOCKER;
  if (blocker === NO_BLOCKER) return { blocker: NO_BLOCKER, reason: null, quote: null, start: null, end: null };

  const reason = bucketOfReason(raw.reason) === blocker ? raw.reason : null;

  const quote = stripRoleLabel(String(raw.quote || ''));
  const hit = quote ? findQuote(verifySegments, quote, { requireRole: 'manager' }) : null;
  if (!hit) {
    // The constraint was asserted but not backed by a real manager line — treat as no blocker.
    console.warn(`[dealBlocker] "${blocker}" dropped: quote not found in a manager segment ("${quote.slice(0, 60)}")`);
    return { blocker: NO_BLOCKER, reason: null, quote: null, start: null, end: null };
  }

  // Adversarial second opinion. A verifier FAILURE must not silently create a blocker, so an error
  // here rejects the candidate: with a base rate this low, a wrong positive costs more than a miss.
  try {
    const verdict = await verifyBlocker(transcript, blocker, quote);
    if (!verdict.confirmed) {
      console.log(`[dealBlocker] "${blocker}" rejected by verifier: ${verdict.reason?.slice(0, 120)}`);
      return { blocker: NO_BLOCKER, reason: null, quote: null, start: null, end: null };
    }
  } catch (err) {
    // ⚠️ Відкинути — правильно (хибний блокер коштує дорожче за пропуск), але ЗАПИСАТИ це як
    // «блокера немає» — ні: збій зв'язку став би невідрізнюваним від перевіреного факту, і жоден
    // наступний прогін такий рядок уже не взяв би. Заміряно на прогоні 19.09.2026: 429 від OpenAI
    // (ліміт 30k токенів/хв ділиться зі звітами) з'їв справжній no_slot саме так.
    // Тому викликачу кажемо «не перевірено», і обидва лишають у БД NULL — рядок повернеться
    // в наступний беклог.
    console.error(`[dealBlocker] verification failed, leaving "${blocker}" unchecked: ${err.message}`);
    return { blocker: NO_BLOCKER, reason: null, quote: null, start: null, end: null, unchecked: true };
  }

  return { blocker, reason, quote, start: hit.start, end: hit.end };
}

export { detectDealBlocker, DEAL_BLOCKERS, NO_BLOCKER, BLOCKER_LABELS, BLOCKER_COLUMNS, BLOCKER_TITLES };
