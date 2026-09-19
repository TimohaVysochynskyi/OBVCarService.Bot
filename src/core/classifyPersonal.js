import { withRetry } from './retry.js';
import { parseModelJson } from './errors.js';
import { fetchOk } from './http.js';
import { NON_SALES_PURPOSES, PURPOSE_RULES } from './callPurpose.js';

const MAX_CHARS = 8000;

const SYSTEM = `Контекст: телефонна розмова на номері менеджера автосервісу (СТО).

Уже встановлено, що це НЕ дзвінок-угода. Обери, що це саме:

${PURPOSE_RULES}

Варіант "sales" виключений — не обирай його.
Якщо сумніваєшся між "other" і "personal" — обирай "other".`;

const SCHEMA = {
  name: 'call_purpose',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      purpose: { type: 'string', enum: NON_SALES_PURPOSES },
      reason: { type: 'string' },
    },
    required: ['purpose', 'reason'],
    additionalProperties: false,
  },
};

const model = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';

async function classifyNonSalesPurpose(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return null;

  const raw = await withRetry(
    async () => {
      const res = await fetchOk('openai', 'визначення типу дзвінка', 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model(),
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: text.slice(0, MAX_CHARS) },
          ],
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      return parseModelJson(await res.json(), 'openai', 'визначення типу дзвінка');
    },
    { attempts: 3, delayMs: 1500, label: 'OpenAI call purpose' }
  );

  return NON_SALES_PURPOSES.includes(raw.purpose) ? { purpose: raw.purpose, reason: raw.reason } : null;
}

export { classifyNonSalesPurpose };
