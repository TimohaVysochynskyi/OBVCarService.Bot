import { withRetry } from './retry.js';
import { definePrompt } from './prompts.js';
import { parseModelJson } from './errors.js';
import { fetchOk } from './http.js';
import { normalize } from './quoteMatch.js';
import { CLIENT_REASON_KEYS, CLIENT_REASONS, reasonPromptList } from './declineReasons.js';

const MAX_CHARS = 12000;
const MIN_EVIDENCE_CHARS = 8;
const NO_EVIDENCE_NEEDED = ['unclear', 'no_answer'];

const declinePrompt = definePrompt({
  key: 'decline',
  group: 'call',
  job: 'decline',
  button: '🚶 Чому клієнт не записався',
  title: '🚶 *Чому клієнт не записався*',
  about:
    'Причина, з якої пішов клієнт, якого СТО МОГЛО взяти: ціна, «подумаю», поїхав до інших тощо. ' +
    '⚠️ Перелік самих причин фіксований кодом — редагується те, як AI між ними обирає.',
});

const SCHEMA = {
  name: 'client_decline',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: CLIENT_REASON_KEYS },
      evidence: { type: 'string' },
    },
    required: ['reason', 'evidence'],
    additionalProperties: false,
  },
};

const model = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';

function evidenceIsReal(transcript, evidence) {
  const quote = normalize(String(evidence || '').replace(/^\s*(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*/i, ''));
  if (quote.length < MIN_EVIDENCE_CHARS) return false;
  return normalize(transcript).includes(quote);
}

async function classifyClientDecline(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return null;

  const raw = await withRetry(
    async () => {
      const res = await fetchOk('openai', 'причина відмови клієнта', 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model(),
          messages: [
            { role: 'system', content: await declinePrompt() },
            { role: 'user', content: text.slice(0, MAX_CHARS) },
          ],
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      return parseModelJson(await res.json(), 'openai', 'причина відмови клієнта');
    },
    { attempts: 3, delayMs: 1500, label: 'OpenAI client decline' }
  );

  if (!CLIENT_REASON_KEYS.includes(raw.reason)) return null;

  if (!NO_EVIDENCE_NEEDED.includes(raw.reason) && !evidenceIsReal(text, raw.evidence)) {
    return { reason: 'unclear', evidence: null, downgraded: true };
  }

  return { reason: raw.reason, evidence: raw.evidence || null };
}

export { classifyClientDecline };
