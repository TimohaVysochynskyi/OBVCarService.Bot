import { withRetry } from "./retry.js";
import { SALES_STAGES } from "./stages.js";
import {
  getStoredScoreRubric,
  setStoredScoreRubric,
  clearStoredScoreRubric,
} from "./store.js";

// Per-call classification: isSuccess (booked/confirmed), weakestStage (one of the shared 4 sales
// stages — core/stages.js), and communicationScore (1-10). isSuccess and weakestStage are objective
// and fixed in the prompt; the communicationScore RUBRIC is the tunable "characteristic by which we
// judge effectiveness" — the owner (director/marketer) edits it from the bot (/rubric), it lives in
// app_state.score_rubric, and getScoreRubric() falls back to the built-in default below. Only the
// wording of the score criteria is tunable; the JSON structure / 1-10 range / stage enum are code.

// Default communication-score rubric. Anchored 1-10 so the model scores consistently across calls
// instead of guessing. Editable via /rubric; owner's text (app_state.score_rubric) overrides this.
const DEFAULT_SCORE_RUBRIC = `Оцінюй цілісне враження від роботи менеджера в розмові за шкалою:
• 9-10 — зразково: привітний професійний контакт; виявив потребу клієнта; чітко й доступно проконсультував; впевнено відпрацював заперечення; проявив ініціативу закрити — запропонував запис і зафіксував конкретну дату/час.
• 7-8 — добре: більшість етапів пройдено якісно, є дрібні недоліки (напр. поверхнево виявив потребу або слабко підвів до запису).
• 5-6 — посередньо: розмова коректна, але кілька ключових етапів провалено (не запропонував запис / не відпрацював заперечення / не уточнив потребу).
• 3-4 — слабко: пасивний, не веде клієнта до рішення, не намагається записати, відповідає лише формально.
• 1-2 — погано: грубість, некомпетентність, дезінформація або втрата клієнта з вини менеджера.

Що враховувати: привітність і тон; виявлення потреби (уточнюючі питання); чіткість і корисність консультації; роботу із запереченнями («дорого», «подумаю», «зроблю в іншому місці»); ініціативу закриття та фіксацію дати запису. Не знижуй бал за те, що не залежало від менеджера (клієнт сам не готовий записуватись зараз), якщо менеджер зробив усе правильно.`;

// Effective rubric = owner's custom text (app_state.score_rubric) or the built-in default.
async function getScoreRubric() {
  return (await getStoredScoreRubric()) || DEFAULT_SCORE_RUBRIC;
}

async function getScoreRubricInfo() {
  const custom = await getStoredScoreRubric();
  return { rubric: custom || DEFAULT_SCORE_RUBRIC, isCustom: Boolean(custom) };
}

async function setScoreRubric(text) {
  await setStoredScoreRubric(text);
}

async function resetScoreRubric() {
  await clearStoredScoreRubric();
}

// The rubric is injected as the communicationScore criteria; the rest (context, isSuccess,
// weakestStage over the shared 4 stages) is fixed.
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

async function classifyCall(transcript) {
  // Read the (possibly owner-edited) rubric once, outside the retry loop.
  const system = buildSystemPrompt(await getScoreRubric());
  return withRetry(
    async () => {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_ANALYZE_MODEL || "gpt-4o-mini",
          messages: [
            { role: "system", content: system },
            { role: "user", content: transcript },
          ],
          response_format: { type: "json_schema", json_schema: SCHEMA },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `OpenAI classification failed: ${res.status} ${await res.text()}`,
        );
      }
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content);
    },
    { attempts: 3, delayMs: 1500, label: "OpenAI call classification" },
  );
}

export {
  classifyCall,
  DEFAULT_SCORE_RUBRIC,
  getScoreRubric,
  getScoreRubricInfo,
  setScoreRubric,
  resetScoreRubric,
};
