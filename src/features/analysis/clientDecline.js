import { definePrompt } from '../prompts/registry.js';
import { chatJson } from '../../platform/openai/llm.js';
import { normalize } from '../../domain/call/quoteMatch.js';
import { CLIENT_REASON_KEYS, CLIENT_REASONS, reasonPromptList } from '../../domain/decline/reasons.js';
import { config } from '../../shared/config.js';

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

const model = () => config.openai.analyzeModel;

function evidenceIsReal(transcript, evidence) {
  const quote = normalize(String(evidence || '').replace(/^\s*(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*/i, ''));
  if (quote.length < MIN_EVIDENCE_CHARS) return false;
  return normalize(transcript).includes(quote);
}

async function classifyClientDecline(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return null;

  const raw = await chatJson({
    op: 'причина відмови клієнта',
    model: model(),
    messages: [
      { role: 'system', content: await declinePrompt() },
      { role: 'user', content: text.slice(0, MAX_CHARS) },
    ],
    temperature: 0,
    schema: SCHEMA,
    attempts: 3,
    delayMs: 1500,
    label: 'OpenAI client decline',
  });

  if (!CLIENT_REASON_KEYS.includes(raw.reason)) return null;

  if (!NO_EVIDENCE_NEEDED.includes(raw.reason) && !evidenceIsReal(text, raw.evidence)) {
    return { reason: 'unclear', evidence: null, downgraded: true };
  }

  return { reason: raw.reason, evidence: raw.evidence || null };
}

export { classifyClientDecline };
