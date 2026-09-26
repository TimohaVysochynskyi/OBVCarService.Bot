import { withRetry } from './retry.js';
import { definePrompt } from './prompts.js';
import { parseModelJson } from './errors.js';
import { fetchOk } from './http.js';

const identifyPrompt = definePrompt({
  key: 'identify',
  group: 'call',
  job: 'identify',
  button: '📞 Хто взяв слухавку (901/902)',
  title: '📞 *Хто взяв слухавку (901/902)*',
  about:
    'На спільних номерах Бінотел не знає, хто відповів, тож AI визначає це з розмови. ' +
    '⚠️ Впливає на те, кому зараховані дзвінки зі спільних номерів.',
});

async function identifyManager(transcript, roster = []) {
  const candidates = (roster || []).filter(Boolean);
  if (candidates.length === 0) return null;

  const schema = {
    name: 'manager_identification',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        operator: {
          type: ['string', 'null'],
          enum: [...candidates, null],
          description: 'Точне ім\'я оператора зі списку кандидатів, або null',
        },
      },
      required: ['operator'],
      additionalProperties: false,
    },
  };

  return withRetry(
    async () => {
      const res = await fetchOk('openai', 'визначення менеджера з розмови', 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: await identifyPrompt() },
            { role: 'user', content: `Кандидати: ${candidates.join(', ')}\n\nТранскрипт:\n${transcript}` },
          ],
          response_format: { type: 'json_schema', json_schema: schema },
        }),
      });
      const data = await res.json();
      const parsed = parseModelJson(data, 'openai', 'визначення менеджера з розмови');
      return parsed.operator || null;
    },
    { attempts: 3, delayMs: 1500, label: 'OpenAI manager identification' }
  );
}

export { identifyManager };
