import { definePrompt } from '../prompts/registry.js';
import { chatJson } from '../../platform/openai/llm.js';
import { MANAGER_ROLE } from '../../domain/call/roles.js';
import { config } from '../../shared/config.js';

const MAX_CHARS = 4000;

const identifyPrompt = definePrompt({
  key: 'identify',
  group: 'call',
  job: 'identify',
  button: '📞 Хто взяв слухавку (901/902)',
  title: '📞 *Хто взяв слухавку (901/902)*',
  about:
    'На спільних номерах Бінотел не знає, хто відповів, тож AI визначає це з розмови. ' +
    '⚠️ Моделі подаються ЛИШЕ репліки нашого працівника — сторону визначає код за каналом запису.',
});

function managerSide(transcript, segments) {
  const lines = (Array.isArray(segments) ? segments : [])
    .filter((s) => s?.role === MANAGER_ROLE)
    .map((s) => String(s.text || '').trim())
    .filter(Boolean);
  if (!lines.length) return { body: String(transcript || '').slice(0, MAX_CHARS), whole: true };
  return { body: lines.join('\n').slice(0, MAX_CHARS), whole: false };
}

async function identifyManager({ transcript, segments } = {}, roster = []) {
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

  const side = managerSide(transcript, segments);
  const header = side.whole ? 'Транскрипт розмови (сторони не розділені)' : 'Репліки НАШОГО працівника';

  const parsed = await chatJson({
    op: 'визначення менеджера з розмови',
    model: config.openai.analyzeModel,
    messages: [
      { role: 'system', content: await identifyPrompt() },
      { role: 'user', content: `Кандидати: ${candidates.join(', ')}\n\n${header}:\n${side.body}` },
    ],
    schema,
    attempts: 3,
    delayMs: 1500,
    label: 'OpenAI manager identification',
  });
  return parsed.operator || null;
}

export { identifyManager };
