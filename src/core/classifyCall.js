import { withRetry } from "./retry.js";
import { parseModelJson } from "./errors.js";
import { fetchOk } from "./http.js";
import { SALES_STAGES } from "./stages.js";
import { definePrompt } from "./prompts.js";
import { dialogueMetrics, metricsPromptBlock, timecodedDialogue } from "./dialogueMetrics.js";

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
  return withRetry(
    async () => {
      const res = await fetchOk("openai", "оцінка дзвінка", "https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_ANALYZE_MODEL || "gpt-4o-mini",
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
          response_format: { type: "json_schema", json_schema: SCHEMA },
        }),
      });
      const data = await res.json();
      return parseModelJson(data, 'openai', 'оцінка дзвінка');
    },
    { attempts: 3, delayMs: 1500, label: "OpenAI call classification" },
  );
}

export {
  classifyCall,
  getScoreRubric,
};
