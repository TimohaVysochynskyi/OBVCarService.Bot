import { SALES_STAGES } from "../../domain/call/stages.js";
import { chatJson } from '../../platform/openai/llm.js';
import { definePrompt } from "../prompts/registry.js";
import { dialogueMetrics, metricsPromptBlock, timecodedDialogue } from "../../domain/call/dialogueMetrics.js";
import { config } from '../../shared/config.js';

const getScoreRubric = definePrompt({
  key: 'score',
  storeKey: 'score_rubric',
  group: 'call',
  job: 'score',
  button: '⭐️ Оцінка комунікації менеджера',
  title: '⭐️ *Оцінка комунікації менеджера*',
  about:
    'Критерії, за якими AI ставить кожному дзвінку-угоді бал 1-10, вирішує, чи записався клієнт, ' +
    'і який етап був найслабшим. ⚠️ Сама шкала 1-10 і перелік етапів фіксовані кодом.',
});

function buildSystemPrompt(rubric) {
  return `Контекст бізнесу: менеджер приймає вхідні дзвінки та здійснює вихідні.
Успішний дзвінок = клієнт записаний на сервіс або підтвердив дату приїзду.

Оціни ЦЕЙ ОДИН дзвінок і поверни структуровані дані:
- isSuccess: чи клієнт записався / підтвердив дату
- weakestStage: який етап продажу (${SALES_STAGES.join(" / ")}) був найслабшим у цьому дзвінку. Якщо етап взагалі не застосовний до цього дзвінка (напр. це просто підтвердження вже існуючого запису) — постав null
- communicationScore: ціле число від 1 до 10 за такою рубрикою:
${rubric}`;
}

const SCHEMA = {
  name: "call_classification",
  strict: true,
  schema: {
    type: "object",
    properties: {
      isSuccess: { type: "boolean" },
      weakestStage: {
        type: ["string", "null"],
        enum: [...SALES_STAGES, null],
      },
      communicationScore: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["isSuccess", "weakestStage", "communicationScore"],
    additionalProperties: false,
  },
};

async function classifyCall(transcript, segments = null) {
  const system = buildSystemPrompt(await getScoreRubric());
  const timecoded = timecodedDialogue(segments);
  const facts = metricsPromptBlock(dialogueMetrics(segments));
  const userContent = [timecoded || transcript, facts].filter(Boolean).join('\n\n');
  return chatJson({
    op: 'оцінка дзвінка',
    model: config.openai.analyzeModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    schema: SCHEMA,
    attempts: 3,
    delayMs: 1500,
    label: "OpenAI call classification",
  });
}

export {
  classifyCall,
  getScoreRubric,
};
