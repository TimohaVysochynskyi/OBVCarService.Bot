import { withRetry } from '../core/retry.js';
import {
  getStoredAnalyzePrompt,
  setStoredAnalyzePrompt,
  clearStoredAnalyzePrompt,
} from '../core/store.js';

// System instruction for the per-manager efficiency analysis. This DEFAULT applies until the
// owner sets a custom one via the bot's /prompt flow (persisted in app_state.analyze_prompt).
// The output is rendered into a PDF (src/bot/pdfReport.js): UPPERCASE lines become section
// headings, *single-asterisk* spans become bold, "-" lines become bullets and "---" a divider.
const DEFAULT_ANALYZE_PROMPT = `Контекст бізнесу: менеджер приймає вхідні дзвінки та здійснює вихідні.
Успішний дзвінок = клієнт записаний на сервіс або підтвердив дату приїзду.

Мені НЕ потрібен розбір кожного дзвінка окремо.
Потрібен узагальнений аналітичний звіт на основі всіх транскриптів разом.

Сформуй звіт суворо у такому форматі (Markdown):

---

ЗАГАЛЬНА ХАРАКТЕРИСТИКА МЕНЕДЖЕРА
5–7 речень. Стиль комунікації, рівень впевненості, структура розмови, емоційний стан (енергія, втома, роздратованість), поведінкові патерни.

---

СИЛЬНІ СТОРОНИ (від 3 до 5 повторюваних позитивних закономірностей)
Кожен пункт:
- *Назва*
- Пояснення
- Приклад фрази або ситуації з дзвінків

---

СИСТЕМНІ ПОМИЛКИ (від 3 до 5 повторюваних слабких місць)
Кожен пункт:
- *Назва проблеми*
- Як саме проявляється
- Чому це шкодить продажу / запису клієнта

---

НАЙСЛАБШИЙ ЕТАП ПРОДАЖУ
Визнач один головний: виявлення потреби / робота із запереченнями / допродаж (масло, фільтри, додаткові роботи) / закриття (фіксація запису).
Поясни чому саме цей етап і як це впливає на результат.

---

ДИНАМІКА ЗА ПЕРІОД
Чи є прогрес або деградація від початку до кінця періоду?
Якщо не можна визначити — так і напиши.

---

ТОП-3 ТОЧКИ РОСТУ
Що змінити в першу чергу для швидкого результату.
Для кожної: що саме змінити і який ефект очікувати.

---

ГОТОВІ ФОРМУЛЮВАННЯ
5–7 конкретних фраз, прив'язаних до реальних ситуацій цього менеджера:
- заперечення "дорого" / "подумаю" / "зроблю в іншому місці"
- момент закриття (фіксація дати запису)
- уточнення проблеми авто`;

// Effective prompt = owner's custom text (app_state) or the built-in default.
async function getAnalyzePrompt() {
  return (await getStoredAnalyzePrompt()) || DEFAULT_ANALYZE_PROMPT;
}

// { prompt, isCustom } — isCustom drives the /prompt screen's status line.
async function getAnalyzePromptInfo() {
  const custom = await getStoredAnalyzePrompt();
  return { prompt: custom || DEFAULT_ANALYZE_PROMPT, isCustom: Boolean(custom) };
}

async function setAnalyzePrompt(text) {
  await setStoredAnalyzePrompt(text);
}

async function resetAnalyzePrompt() {
  await clearStoredAnalyzePrompt();
}

const MAX_TRANSCRIPT_CHARS = 1500;
const MAX_TOTAL_CHARS = 14000;

function buildUserContent(managerName, calls, stats) {
  let block = '';
  let used = 0;
  let included = 0;
  for (const c of calls) {
    const piece = `--- Дзвінок (${c.startTime}) ---\n${(c.transcript || '').slice(0, MAX_TRANSCRIPT_CHARS)}\n\n`;
    if (used + piece.length > MAX_TOTAL_CHARS) break;
    block += piece;
    used += piece.length;
    included += 1;
  }
  const omitted = calls.length - included;
  const statsLine = `Менеджер: ${managerName}. Дзвінків: ${stats.callCount}, успішних: ${stats.successCount}, середній бал: ${stats.avgScore ?? '—'}.`;
  const note = omitted > 0 ? `\n(показано ${included} з ${calls.length} транскриптів, решту опущено через обсяг)` : '';
  return `${statsLine}${note}\n\nТранскрипти:\n\n${block}`;
}

// calls: [{ transcript, startTime, isSuccess, weakestStage, communicationScore }]
async function analyzeManager(managerName, calls) {
  const successCount = calls.filter((c) => c.isSuccess).length;
  const scored = calls.filter((c) => typeof c.communicationScore === 'number');
  const avgScore = scored.length
    ? Math.round((scored.reduce((s, c) => s + c.communicationScore, 0) / scored.length) * 10) / 10
    : null;
  const stats = { callCount: calls.length, successCount, avgScore };

  const systemPrompt = await getAnalyzePrompt();
  const summary = await withRetry(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildUserContent(managerName, calls, stats) },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI manager report failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return data.choices[0].message.content;
    },
    { attempts: 3, delayMs: 2000, label: `OpenAI report ${managerName}` }
  );

  return { managerName, stats, summary };
}

export {
  analyzeManager,
  DEFAULT_ANALYZE_PROMPT,
  getAnalyzePrompt,
  getAnalyzePromptInfo,
  setAnalyzePrompt,
  resetAnalyzePrompt,
};
