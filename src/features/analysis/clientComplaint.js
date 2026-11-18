import { definePrompt } from '../prompts/registry.js';
import { chatJson } from '../../platform/openai/llm.js';
import { findQuote } from '../../domain/call/quoteMatch.js';
import { CLIENT_ROLE } from '../../domain/call/roles.js';
import { COMPLAINT_KEYS, complaintPromptList } from '../../domain/call/complaint.js';
import { config } from '../../shared/config.js';

const MAX_CHARS = 12000;
const MIN_QUOTE_CHARS = 12;

const complaintPrompt = definePrompt({
  key: 'complaint',
  group: 'call',
  job: 'complaint',
  button: '😠 Незадоволення клієнта',
  title: '😠 *Незадоволення клієнта*',
  about:
    'Чи висловив клієнт претензію до нас — не передзвонили, довго чекає, дорого, погана якість. ' +
    '⚠️ Цитата береться з реплік КЛІЄНТА і перевіряється кодом: це єдиний тип висновку, ' +
    'де доказом є слова клієнта, а не менеджера.',
});

const SCHEMA = {
  name: 'client_complaint',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      hasComplaint: { type: 'boolean' },
      type: { type: ['string', 'null'], enum: [...COMPLAINT_KEYS, null] },
      quote: { type: ['string', 'null'] },
    },
    required: ['hasComplaint', 'type', 'quote'],
    additionalProperties: false,
  },
};

const NO_COMPLAINT = { hasComplaint: false, type: null, quote: null, start: null, end: null, segIndex: null };

async function detectClientComplaint(transcript, segments) {
  const text = String(transcript || '').trim();
  if (!text) return NO_COMPLAINT;

  const system =
    `${await complaintPrompt()}\n\n` +
    `ПЕРЕЛІК ТИПІВ (обери рівно один, якщо незадоволення прозвучало):\n${complaintPromptList()}`;

  const raw = await chatJson({
    op: 'незадоволення клієнта',
    model: config.openai.analyzeModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text.slice(0, MAX_CHARS) },
    ],
    temperature: 0,
    schema: SCHEMA,
    attempts: 3,
    delayMs: 1500,
    label: 'OpenAI client complaint',
  });

  if (!raw.hasComplaint || !COMPLAINT_KEYS.includes(raw.type)) return NO_COMPLAINT;

  const quote = String(raw.quote || '').trim();
  if (quote.length < MIN_QUOTE_CHARS) return NO_COMPLAINT;

  const hit = Array.isArray(segments) && segments.length
    ? findQuote(segments, quote, { requireRole: CLIENT_ROLE })
    : null;
  if (Array.isArray(segments) && segments.length && !hit) return NO_COMPLAINT;

  return {
    hasComplaint: true,
    type: raw.type,
    quote,
    start: hit?.start ?? null,
    end: hit?.end ?? null,
    segIndex: hit?.segIndex ?? null,
  };
}

export { detectClientComplaint, NO_COMPLAINT };
