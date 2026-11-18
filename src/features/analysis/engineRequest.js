import { definePrompt } from '../prompts/registry.js';
import { chatJson } from '../../platform/openai/llm.js';
import { normalize } from '../../domain/call/quoteMatch.js';
import { ENGINE_SERVICE_KEYS, mentionsEngine, servicePromptList } from '../../domain/call/engine.js';
import { config } from '../../shared/config.js';

const MAX_CHARS = 12000;
const MIN_EVIDENCE_CHARS = 8;
const MAX_CAR_CHARS = 60;

const enginePrompt = definePrompt({
  key: 'engine',
  group: 'call',
  job: 'engine',
  button: '🔧 Звернення по двигуну',
  title: '🔧 *Звернення по двигуну*',
  about:
    'Чи дзвонив клієнт саме по двигуну, яка послуга потрібна і про яке авто йдеться. ' +
    'Потрібно, щоб бачити віддачу від реклами ремонту моторів. ' +
    '⚠️ Перелік послуг фіксований кодом; цитату код перевіряє проти транскрипту.',
});

const SCHEMA = {
  name: 'engine_request',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      isEngineRequest: { type: 'boolean' },
      service: { type: ['string', 'null'], enum: [...ENGINE_SERVICE_KEYS, null] },
      car: { type: ['string', 'null'] },
      evidence: { type: ['string', 'null'] },
    },
    required: ['isEngineRequest', 'service', 'car', 'evidence'],
    additionalProperties: false,
  },
};

const model = () => config.openai.analyzeModel;

function quoteIsReal(transcript, evidence) {
  const quote = normalize(String(evidence || '').replace(/^\s*(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*/i, ''));
  if (quote.length < MIN_EVIDENCE_CHARS) return false;
  return normalize(transcript).includes(quote);
}

function cleanCar(car) {
  const text = String(car || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_CAR_CHARS) return null;
  if (/^(не\s|немає|невідом|неизвест|не вказ|не назв|unknown|null|n\/a|[—-]$)/i.test(text)) return null;
  return text;
}

const NOT_ENGINE = { isEngineRequest: false, service: null, car: null, quote: null };

async function detectEngineRequest(transcript) {
  const text = String(transcript || '').trim();
  if (!text || !mentionsEngine(text)) return NOT_ENGINE;

  const system =
    `${await enginePrompt()}\n\n` +
    `ПЕРЕЛІК ПОСЛУГ (обери рівно одну, якщо це звернення по двигуну):\n${servicePromptList()}`;

  const raw = await chatJson({
    op: 'звернення по двигуну',
    model: model(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text.slice(0, MAX_CHARS) },
    ],
    temperature: 0,
    schema: SCHEMA,
    attempts: 3,
    delayMs: 1500,
    label: 'OpenAI engine request',
  });

  if (!raw.isEngineRequest) return NOT_ENGINE;
  if (!ENGINE_SERVICE_KEYS.includes(raw.service)) return NOT_ENGINE;
  if (!quoteIsReal(text, raw.evidence)) return NOT_ENGINE;

  return {
    isEngineRequest: true,
    service: raw.service,
    car: cleanCar(raw.car),
    quote: String(raw.evidence).trim(),
  };
}

export { detectEngineRequest, NOT_ENGINE };
