import { findQuote } from '../../domain/call/quoteMatch.js';
import { chatJson } from '../../platform/openai/llm.js';
import { SALES_STAGES } from '../../domain/call/stages.js';
import { config } from '../../shared/config.js';


const ANALYSIS_VERSION = 2;
const MAX_ITEMS = 8;
const model = () => config.openai.analyzeModel;
const NO_INTRO = { name: false, company: false };


import { CALL_PURPOSES, purposeRules } from '../../domain/call/purpose.js';
import { definePrompt } from '../prompts/registry.js';
import { introRules, verifyIntro } from '../../domain/call/intro.js';

const behaviourRules = definePrompt({
  key: 'behaviour',
  group: 'call',
  job: 'map',
  button: '🔍 Сильні й слабкі сторони в розмові',
  title: '🔍 *Сильні й слабкі сторони в розмові*',
  about:
    'Що саме AI виписує з кожного дзвінка-угоди як сильну чи слабку поведінку менеджера. ' +
    'Саме з цих поведінок потім збираються висновки у звіті. ' +
    '⚠️ Правило «цитата має бути справжньою реплікою менеджера» тримає код і не редагується.',
});

async function systemPrompt() {
  return `Контекст: менеджер автосервісу (СТО) веде телефонну розмову.

КРОК 0 — чи ПРЕДСТАВИВСЯ менеджер (intro). Заповнюй ЗАВЖДИ, на дзвінку будь-якого типу:
${await introRules()}

КРОК 1 — визнач ТИП дзвінка (callPurpose):
${await purposeRules()}

КРОК 2 — поведінки менеджера (items):
${await behaviourRules()}`;
}

const SCHEMA = {
  name: 'call_behaviors',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      callPurpose: { type: 'string', enum: CALL_PURPOSES },
      intro: {
        type: 'object',
        properties: {
          name: { type: 'boolean' },
          nameQuote: { type: 'string' },
          company: { type: 'boolean' },
          companyQuote: { type: 'string' },
        },
        required: ['name', 'nameQuote', 'company', 'companyQuote'],
        additionalProperties: false,
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['strength', 'error'] },
            stage: { type: 'string', enum: SALES_STAGES },
            label: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['type', 'stage', 'label', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['callPurpose', 'intro', 'items'],
    additionalProperties: false,
  },
};

function pseudoSegments(transcript) {
  const text = String(transcript || '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) {
    const m = /^(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*(.*)$/i.exec(l);
    if (m) out.push({ role: /менеджер|оператор/i.test(m[1]) ? 'manager' : 'client', text: m[2], start: null, end: null });
    else out.push({ role: 'manager', text: l, start: null, end: null });
  }
  if (out.length === 0 && text.trim()) out.push({ role: 'manager', text: text.trim(), start: null, end: null });
  return out;
}

async function analyzeCallBehaviors(transcript, segments, managerName) {
  const verifySegments = Array.isArray(segments) && segments.length ? segments : pseudoSegments(transcript);
  if (!transcript || !verifySegments.length) return { version: ANALYSIS_VERSION, callPurpose: 'other', intro: NO_INTRO, items: [] };

  const system = await systemPrompt();
  const raw = await chatJson({
    op: 'аналіз поведінки в дзвінку',
    model: model(),
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `${managerName ? `Менеджер: ${managerName}\n\n` : ''}Транскрипт:\n${transcript}`,
      },
    ],
    schema: SCHEMA,
    attempts: 2,
    delayMs: 1500,
    label: 'OpenAI call behaviors',
  });

  const callPurpose = CALL_PURPOSES.includes(raw.callPurpose) ? raw.callPurpose : 'other';
  const intro = verifyIntro(raw.intro, verifySegments, managerName);
  if (callPurpose !== 'sales') return { version: ANALYSIS_VERSION, callPurpose, intro, items: [] };

  const items = [];
  for (const it of (raw.items || []).slice(0, MAX_ITEMS)) {
    if (!it?.quote) continue;
    const hit = findQuote(verifySegments, it.quote, { requireRole: 'manager' });
    if (!hit) continue;
    items.push({
      type: it.type === 'strength' ? 'strength' : 'error',
      stage: SALES_STAGES.includes(it.stage) ? it.stage : SALES_STAGES[0],
      label: String(it.label || '').trim(),
      quote: it.quote.trim(),
      start: hit.start,
      end: hit.end,
      segIndex: hit.segIndex,
    });
  }
  return { version: ANALYSIS_VERSION, callPurpose, intro, items };
}

export { analyzeCallBehaviors, ANALYSIS_VERSION, CALL_PURPOSES, pseudoSegments };
