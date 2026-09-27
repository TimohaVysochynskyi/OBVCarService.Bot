import { normalize } from './quoteMatch.js';
import { chatJson } from '../platform/openai/llm.js';
import { NON_SALES_PURPOSES, purposeRules } from './callPurpose.js';
import { definePrompt } from './prompts.js';
import { config } from '../shared/config.js';

const MAX_CHARS = 8000;

const personalPrompt = definePrompt({
  key: 'personal',
  group: 'call',
  job: 'personal',
  button: '🏠 Особисті дзвінки',
  title: '🏠 *Особисті дзвінки*',
  about:
    'Як AI відокремлює справді особисті розмови від робочих на робочому номері. ' +
    '⚠️ Цей розбір НІКОЛИ не робить дзвінок угодою, тож конверсія від нього не зрушить.',
});

async function personalSystem() {
  return `Контекст: телефонна розмова на робочому номері працівника автосервісу (СТО).

Уже встановлено, що це НЕ дзвінок-угода. Обери, що це саме:

${await purposeRules()}

${await personalPrompt()}`;
}

const SCHEMA = {
  name: 'call_purpose',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      purpose: { type: 'string', enum: NON_SALES_PURPOSES },
      reason: { type: 'string' },
      evidence: { type: 'string' },
    },
    required: ['purpose', 'reason', 'evidence'],
    additionalProperties: false,
  },
};

const MIN_EVIDENCE_CHARS = 12;

const model = () => config.openai.analyzeModel;

function evidenceIsReal(transcript, evidence) {
  const quote = normalize(String(evidence || '').replace(/^\s*(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*/i, ''));
  if (quote.length < MIN_EVIDENCE_CHARS) return false;
  return normalize(transcript).includes(quote);
}

async function classifyNonSalesPurpose(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return null;

  const raw = await chatJson({
    op: 'визначення типу дзвінка',
    model: model(),
    messages: [
      { role: 'system', content: await personalSystem() },
      { role: 'user', content: text.slice(0, MAX_CHARS) },
    ],
    temperature: 0,
    schema: SCHEMA,
    attempts: 3,
    delayMs: 1500,
    label: 'OpenAI call purpose',
  });

  if (!NON_SALES_PURPOSES.includes(raw.purpose)) return null;

  if (raw.purpose === 'personal' && !evidenceIsReal(text, raw.evidence)) {
    return { purpose: 'other', reason: raw.reason, evidence: null, downgraded: true };
  }

  return { purpose: raw.purpose, reason: raw.reason, evidence: raw.evidence || null };
}

export { classifyNonSalesPurpose, evidenceIsReal };
