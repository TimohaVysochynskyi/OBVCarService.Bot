import { withRetry } from './retry.js';
import { findQuote } from './quoteMatch.js';
import { pseudoSegments } from './analyzeCall.js';

// "Незакриті угоди" — a deal that did NOT close for a reason that is NOT the manager's fault: the
// СТО itself could not take the job. Without this, every such call counted as a failed deal and
// dragged the manager's conversion down for something he could not sell.
//
// EXACTLY TWO categories (owner's decision 2026-07-30) — they are also the two dynamics columns:
//   • no_slot      («Черга»)   — no free time/slot: fully booked, queue, no lift free, not this week
//   • out_of_scope («Профіль») — the СТО does not provide it at all: wrong type of car, service not
//                                offered, no equipment/specialist, the needed part is unobtainable
//
// Reliability follows the same rule as the rest of the analysis: the model must return a VERBATIM
// MANAGER line, and CODE re-locates it in the call's segments (findQuote, requireRole:'manager').
// A quote that cannot be located means the blocker is dropped — so a hallucinated or paraphrased
// "СТО was full" can never reach the report or the counters.
//
// Model: OPENAI_BLOCKER_MODEL, default gpt-4o (NOT the cheap mini used elsewhere) — the owner asked
// for maximum accuracy here, and the volume makes it irrelevant: this runs only on calls that did
// not close (~19/day live, 766 rows for the whole history), on ~850-character transcripts.

const NO_BLOCKER = 'none';
const DEAL_BLOCKERS = ['no_slot', 'out_of_scope'];

// Full wording for the report; SHORT wording for the dynamics table columns (must stay narrow so the
// 6-column table still fits a phone screen).
const BLOCKER_LABELS = {
  no_slot: 'СТО забите — немає вільного місця/часу',
  out_of_scope: 'Не наш профіль — такої послуги/таких авто не беремо',
};
const BLOCKER_COLUMNS = { no_slot: 'Черга', out_of_scope: 'Профіль' };

const model = () => process.env.OPENAI_BLOCKER_MODEL || 'gpt-4o';

const SYSTEM_PROMPT = `Ти аналізуєш телефонну розмову менеджера автосервісу (СТО) з клієнтом.

ЗАВДАННЯ: визначити, чи клієнта НЕ ВЗЯЛИ на обслуговування САМЕ ЧЕРЕЗ ОБМЕЖЕННЯ САМОГО СТО — тобто менеджер зробив усе, що міг, але сервіс фізично/принципово не міг надати послугу.

Поверни РІВНО одне значення blocker:

1) "no_slot" — НЕМАЄ ВІЛЬНОГО ЧАСУ АБО МІСЦЯ. СТО в принципі робить те, що просить клієнт, але зараз не може взяти.
   Приклади реплік менеджера: «на цьому тижні все забито», «вільних місць немає», «найближче вікно тільки в понеділок», «зараз черга на два тижні», «сьогодні вже не візьмемо, майстри завантажені», «усі підйомники зайняті», «до кінця місяця записів немає», «майстер у відпустці до 10-го».

2) "out_of_scope" — СТО НЕ НАДАЄ ЦЬОГО ВЗАГАЛІ. Час тут ні до чого.
   • не той тип/марка авто: «вантажні не беремо», «з електромобілями не працюємо», «американські не обслуговуємо», «мотоцикли — ні».
   • немає такої послуги: «кузовним ремонтом не займаємось», «фарбування не робимо», «АКПП не ремонтуємо», «шиномонтажу в нас немає».
   • немає обладнання чи спеціаліста для цієї роботи: «у нас немає стенда для цього», «такою діагностикою не займаємось».
   • потрібної запчастини немає і дістати неможливо: «на цю модель запчастин не знайти».

3) "${NO_BLOCKER}" — усе інше. ЦЕ ЗНАЧЕННЯ ЗА ЗАМОВЧУВАННЯМ: якщо сумніваєшся — ставь "${NO_BLOCKER}".

КРИТИЧНО ВАЖЛИВО — це НЕ блокер (тут ставь "${NO_BLOCKER}"):
- Клієнта не влаштувала ЦІНА («дорого», «подумаю», «в іншому місці дешевше») — це заперечення, з ним працює менеджер.
- Клієнт сам передумав, сказав «перетелефоную», «пораджуся», просто попрощався або кинув слухавку.
- Клієнта успішно ЗАПИСАЛИ — навіть якщо на пізнішу дату, навіть якщо спершу сказали, що на цьому тижні місць немає. Записали = угода закрита, блокера НЕМА.
- Менеджер САМ не знав, чи є місце / не перевірив / не запропонував альтернативу / забув узяти номер — це провтик МЕНЕДЖЕРА, а не обмеження СТО.
- Дзвінок узагалі не про запис: клієнт питає статус своєї машини, менеджер повідомляє, що робота готова, службовий/помилковий дзвінок.
- Обмеження згадав КЛІЄНТ, а не менеджер (напр. клієнт сам сказав «у вас, мабуть, усе забито»).

ЦИТАТА (quote):
- Якщо blocker НЕ "${NO_BLOCKER}" — наведи РІВНО ОДИН рядок МЕНЕДЖЕРА, СКОПІЙОВАНИЙ ДОСЛІВНО з транскрипту (той самий текст, без переказу, перекладу чи виправлень), у якому це обмеження прямо сказане.
- Цитата має САМА ПО СОБІ доводити обмеження. Якщо такого дослівного рядка менеджера немає — ставь blocker "${NO_BLOCKER}" і порожню цитату.
- Якщо blocker = "${NO_BLOCKER}" — quote порожній рядок.`;

const SCHEMA = {
  name: 'deal_blocker',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      blocker: { type: 'string', enum: [...DEAL_BLOCKERS, NO_BLOCKER] },
      quote: { type: 'string' },
    },
    required: ['blocker', 'quote'],
    additionalProperties: false,
  },
};

// Returns { blocker: 'no_slot'|'out_of_scope'|'none', quote, start, end }.
// 'none' is returned for anything unclear, and ALSO whenever the model's quote cannot be located in a
// manager segment — the counters and the report must never rest on an unverifiable claim.
async function detectDealBlocker(transcript, segments, managerName) {
  const verifySegments = Array.isArray(segments) && segments.length ? segments : pseudoSegments(transcript);
  if (!transcript || !verifySegments.length) return { blocker: NO_BLOCKER, quote: null, start: null, end: null };

  const raw = await withRetry(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model(),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `${managerName ? `Менеджер: ${managerName}\n\n` : ''}Транскрипт:\n${transcript}`,
            },
          ],
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI deal-blocker failed: ${res.status} ${await res.text()}`);
      return JSON.parse((await res.json()).choices[0].message.content);
    },
    { attempts: 2, delayMs: 1500, label: 'OpenAI deal blocker' }
  );

  const blocker = DEAL_BLOCKERS.includes(raw.blocker) ? raw.blocker : NO_BLOCKER;
  if (blocker === NO_BLOCKER) return { blocker: NO_BLOCKER, quote: null, start: null, end: null };

  const quote = String(raw.quote || '').trim();
  const hit = quote ? findQuote(verifySegments, quote, { requireRole: 'manager' }) : null;
  if (!hit) {
    // The constraint was asserted but not backed by a real manager line — treat as no blocker.
    console.warn(`[dealBlocker] "${blocker}" dropped: quote not found in a manager segment ("${quote.slice(0, 60)}")`);
    return { blocker: NO_BLOCKER, quote: null, start: null, end: null };
  }
  return { blocker, quote, start: hit.start, end: hit.end };
}

export { detectDealBlocker, DEAL_BLOCKERS, NO_BLOCKER, BLOCKER_LABELS, BLOCKER_COLUMNS };
