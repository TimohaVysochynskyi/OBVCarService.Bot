import { definePrompt } from '../prompts/registry.js';
import { chatJson } from '../../platform/openai/llm.js';
import { config } from '../../shared/config.js';

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

  const parsed = await chatJson({
    op: 'визначення менеджера з розмови',
    model: config.openai.analyzeModel,
    messages: [
      { role: 'system', content: await identifyPrompt() },
      { role: 'user', content: `Кандидати: ${candidates.join(', ')}\n\nТранскрипт:\n${transcript}` },
    ],
    schema,
    attempts: 3,
    delayMs: 1500,
    label: 'OpenAI manager identification',
  });
  return parsed.operator || null;
}

export { identifyManager };
