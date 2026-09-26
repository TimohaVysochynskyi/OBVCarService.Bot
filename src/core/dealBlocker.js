import { withRetry } from './retry.js';
import { definePrompt } from './prompts.js';
import { parseModelJson } from './errors.js';
import { fetchOk } from './http.js';
import { findQuote } from './quoteMatch.js';
import { pseudoSegments } from './analyzeCall.js';
import { SERVICE_REASON_KEYS, bucketOfReason, reasonsOfBucket, reasonPromptList } from './declineReasons.js';


const NO_BLOCKER = 'none';
const DEAL_BLOCKERS = ['no_slot', 'no_parts', 'out_of_scope'];

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
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: VERIFY_SCHEMA },
    }),
  });
  return parseModelJson(await res.json(), 'openai', 'перевірка незакритої угоди');
}

function stripRoleLabel(quote) {
  return quote.replace(/^\s*(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*/i, '').trim();
}

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
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      return parseModelJson(await res.json(), 'openai', 'пошук незакритої угоди');
    },
    { attempts: 4, delayMs: 4000, label: 'OpenAI deal blocker' }
  );

  const blocker = DEAL_BLOCKERS.includes(raw.blocker) ? raw.blocker : NO_BLOCKER;
  if (blocker === NO_BLOCKER) return { blocker: NO_BLOCKER, reason: null, quote: null, start: null, end: null };

  const reason = bucketOfReason(raw.reason) === blocker ? raw.reason : null;

  const quote = stripRoleLabel(String(raw.quote || ''));
  const hit = quote ? findQuote(verifySegments, quote, { requireRole: 'manager' }) : null;
  if (!hit) {
    console.warn(`[dealBlocker] "${blocker}" dropped: quote not found in a manager segment ("${quote.slice(0, 60)}")`);
    return { blocker: NO_BLOCKER, reason: null, quote: null, start: null, end: null };
  }

  try {
    const verdict = await verifyBlocker(transcript, blocker, quote);
    if (!verdict.confirmed) {
      console.log(`[dealBlocker] "${blocker}" rejected by verifier: ${verdict.reason?.slice(0, 120)}`);
      return { blocker: NO_BLOCKER, reason: null, quote: null, start: null, end: null };
    }
  } catch (err) {
    console.error(`[dealBlocker] verification failed, leaving "${blocker}" unchecked: ${err.message}`);
    return { blocker: NO_BLOCKER, reason: null, quote: null, start: null, end: null, unchecked: true };
  }

  return { blocker, reason, quote, start: hit.start, end: hit.end };
}

export { detectDealBlocker, DEAL_BLOCKERS, NO_BLOCKER, BLOCKER_LABELS, BLOCKER_COLUMNS, BLOCKER_TITLES };
