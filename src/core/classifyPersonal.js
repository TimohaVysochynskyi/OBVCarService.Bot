import { withRetry } from './retry.js';
import { parseModelJson } from './errors.js';
import { fetchOk } from './http.js';
import { normalize } from './quoteMatch.js';
import { NON_SALES_PURPOSES, PURPOSE_RULES } from './callPurpose.js';

const MAX_CHARS = 8000;

const SYSTEM = `Контекст: телефонна розмова на робочому номері працівника автосервісу (СТО).

Уже встановлено, що це НЕ дзвінок-угода. Обери, що це саме:

${PURPOSE_RULES}

Варіант "sales" виключений — не обирай його.

⚠️ "personal" — РІДКІСНИЙ варіант. За замовчуванням дзвінок на робочому номері РОБОЧИЙ.
Це РОБОЧІ дзвінки ("other"), а не особисті:
- координація приїзду, зміни, зустрічі на роботі: "ти на місці?", "я під'їжджаю", "буду за десять хвилин", "тебе чекаю";
- коротка розмова зі знайомим, який їде на сервіс або вже там;
- прохання передати слухавку колезі, пошук людини, перемикання між працівниками;
- постачальники, запчастини, посилки, перевізники, таксі для робочих потреб;
- будь-яка згадка авто, ремонту, деталей, запису — навіть якщо співрозмовники на "ти" і без привітань.

"personal" обирай ЛИШЕ тоді, коли в розмові є ЯВНА неробоча тема: сім'я, побут, здоров'я, гроші поза роботою, приватні плани, не пов'язані зі СТО.

Поле "evidence": якщо обрав "personal" — скопіюй ДОСЛІВНО один рядок із розмови, у якому видно цю неробочу тему. Не переказуй і не перекладай. Якщо такого рядка немає — це не "personal", обирай "other" і лиши "evidence" порожнім.`;

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

const model = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';

function evidenceIsReal(transcript, evidence) {
  const quote = normalize(String(evidence || '').replace(/^\s*(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*/i, ''));
  if (quote.length < MIN_EVIDENCE_CHARS) return false;
  return normalize(transcript).includes(quote);
}

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

  if (!NON_SALES_PURPOSES.includes(raw.purpose)) return null;

  if (raw.purpose === 'personal' && !evidenceIsReal(text, raw.evidence)) {
    return { purpose: 'other', reason: raw.reason, evidence: null, downgraded: true };
  }

  return { purpose: raw.purpose, reason: raw.reason, evidence: raw.evidence || null };
}

export { classifyNonSalesPurpose, evidenceIsReal };
