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

ОБИДВІ УМОВИ мусять виконуватись одночасно, інакше — "${NO_BLOCKER}":
 (А) клієнт справді хотів послугу або запис у цій розмові;
 (Б) менеджер ПРЯМО сказав, що СТО цього зробити не може.

Поверни РІВНО одне значення blocker.

ГОЛОВНИЙ ТЕСТ, який відрізняє дві категорії: «чи взяли б цього клієнта ІНШОГО ДНЯ?»
- ТАК, взяли б, просто зараз немає коли → "no_slot" (обмеження ТИМЧАСОВЕ).
- НІ, не взяли б і наступного місяця, ми такого не робимо → "out_of_scope" (обмеження ПОСТІЙНЕ).

1) "no_slot" — ТИМЧАСОВО немає можливості взяти: немає вільного часу, місця чи потрібної людини саме зараз. Послугу СТО в принципі надає.
   Приклади реплік менеджера: «на цьому тижні все забито», «вільних місць немає», «найближче вікно тільки в понеділок», «зараз черга на два тижні», «сьогодні вже не візьмемо, майстри завантажені», «усі підйомники зайняті», «до кінця місяця записів немає», «майстер у відпустці до 10-го», «електрика зараз немає», «у мене вся чотири машини стоїть на розвал».

2) "out_of_scope" — СТО НЕ НАДАЄ ЦЬОГО ВЗАГАЛІ, і час тут ні до чого.
   • не той тип/марка авто: «вантажні не беремо», «з електромобілями не працюємо», «американські не обслуговуємо», «мотоцикли — ні».
   • немає такої послуги: «кузовним ремонтом не займаємось», «фарбування не робимо», «АКПП не ремонтуємо», «шиномонтажу в нас немає».
   • немає обладнання, якого в сервісі взагалі НЕ ІСНУЄ: «у нас немає стенда для цього», «такою діагностикою не займаємось».
   • потрібної запчастини немає і дістати її неможливо: «на цю модель запчастин не знайти».
   ⚠️ УВАГА: якщо потрібний майстер/спеціаліст просто ВІДСУТНІЙ ЗАРАЗ (хворий, у відпустці, завантажений) — це "no_slot", а НЕ "out_of_scope", бо іншого дня його візьмуть.

3) "${NO_BLOCKER}" — усе інше. ЦЕ ЗНАЧЕННЯ ЗА ЗАМОВЧУВАННЯМ: якщо сумніваєшся — ставь "${NO_BLOCKER}".

⚠️ ПАСТКИ МОВИ АВТОСЕРВІСУ (перевірено на реальних розмовах цього СТО — саме тут найчастіше помиляються):
- «забитий/забито» в автосервісі ЗАЗВИЧАЙ означає ЗАСМІЧЕНИЙ вузол, а не завантажений сервіс: «радіатори забиті», «фільтр був забитий», «сітка забита», «воно забилося» → це ДІАГНОСТИКА ДЕТАЛІ, blocker="${NO_BLOCKER}". Тільки «у нас усе забито», «забито на сьогодні», «забито на місяць» (про ЗАПИС/ГРАФІК) може бути "no_slot".
- «робимо, не робимо» — менеджер пропонує КЛІЄНТУ вирішити, робити роботу чи ні. Це НЕ відмова → "${NO_BLOCKER}".
- Роздуми менеджера про те, що для роботи «потрібен хтось знаючий», «треба розбиратися по схемах» — це НЕ відмова сервісу → "${NO_BLOCKER}".
- Про завантаженість/відсутність місць запитав КЛІЄНТ, а менеджер не підтвердив → "${NO_BLOCKER}".

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

// Second, ADVERSARIAL pass. Measured on live data the base rate of a real blocker is tiny (roughly
// 2-4 calls in six weeks), so precision dominates: at even a 5% false-positive rate a single pass
// over the history would invent dozens of blockers, drown the few real ones and — because blocked
// calls leave the conversion denominator — silently flatter every manager. The detector alone was
// measured producing ~1 false positive in 3 (a manager musing "someone who knows should look at the
// wiring" was read as a refusal), so a strict reviewer that DEFAULTS TO REJECT is what makes the
// number trustworthy. Same shape as the findings relevance pass in bot/analyze.js.
const VERIFY_SYSTEM = `Ти СУВОРИЙ рецензент. Інша модель твердить, що в цій розмові СТО не змогло взяти клієнта. Твоє завдання — ВІДКИНУТИ твердження, якщо воно не доведене.

Підтверджуй (confirmed=true) ТІЛЬКИ якщо виконано ВСЕ:
1. Клієнт у цій розмові справді хотів послугу або запис.
2. Наведена цитата — це слова МЕНЕДЖЕРА, і в них ПРЯМО сказано, що СТО не може цього зробити (немає вільного часу / не надаємо таке).
3. Причина в САМОМУ СТО, а не в клієнті (не ціна, не «подумаю», не «перетелефоную»).
4. Клієнта в результаті НЕ записали (якщо записали, хай і на іншу дату — це закрита угода, confirmed=false).

Відкидай (confirmed=false), якщо цитата насправді про: засмічену деталь («радіатор забитий», «фільтр забитий»), пропозицію клієнтові вирішити («робимо, не робимо»), роздуми про потрібного спеціаліста, запитання клієнта без підтвердження менеджера, або якщо ти просто не впевнений.

Якщо сумніваєшся — confirmed=false.`;

const VERIFY_SCHEMA = {
  name: 'blocker_verdict',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      confirmed: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['confirmed', 'reason'],
    additionalProperties: false,
  },
};

async function verifyBlocker(transcript, blocker, quote) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model(),
      messages: [
        { role: 'system', content: VERIFY_SYSTEM },
        {
          role: 'user',
          content:
            `Твердження: ${BLOCKER_LABELS[blocker]}\nЦитата менеджера: «${quote}»\n\nПовна розмова:\n${transcript}`,
        },
      ],
      temperature: 0, // same reason as the detector: the verdict must be reproducible
      response_format: { type: 'json_schema', json_schema: VERIFY_SCHEMA },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI blocker verify failed: ${res.status} ${await res.text()}`);
  return JSON.parse((await res.json()).choices[0].message.content);
}

// The model sometimes copies the transcript line WITH its role label ("Менеджер: ..."). Strip it so
// the stored quote reads cleanly in the report (and matches the segment text, which has no label).
function stripRoleLabel(quote) {
  return quote.replace(/^\s*(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*/i, '').trim();
}

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
          // Pinned to 0: this is a COUNTED metric feeding the growth time series, so re-running the
          // backfill must reproduce the same numbers. Observed at the default temperature: the same
          // call flipped between 'none' and a blocker across runs, which would silently rewrite
          // history. (The rest of the project's LLM calls still use the default - they produce prose,
          // not counters, so changing those is a separate decision.)
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI deal-blocker failed: ${res.status} ${await res.text()}`);
      return JSON.parse((await res.json()).choices[0].message.content);
    },
    // gpt-4o on this account has a 30k tokens/min cap and the report reduce uses the same model, so
    // 429s are expected under load - back off longer and try more often than the mini-model callers.
    { attempts: 4, delayMs: 4000, label: 'OpenAI deal blocker' }
  );

  const blocker = DEAL_BLOCKERS.includes(raw.blocker) ? raw.blocker : NO_BLOCKER;
  if (blocker === NO_BLOCKER) return { blocker: NO_BLOCKER, quote: null, start: null, end: null };

  const quote = stripRoleLabel(String(raw.quote || ''));
  const hit = quote ? findQuote(verifySegments, quote, { requireRole: 'manager' }) : null;
  if (!hit) {
    // The constraint was asserted but not backed by a real manager line — treat as no blocker.
    console.warn(`[dealBlocker] "${blocker}" dropped: quote not found in a manager segment ("${quote.slice(0, 60)}")`);
    return { blocker: NO_BLOCKER, quote: null, start: null, end: null };
  }

  // Adversarial second opinion. A verifier FAILURE must not silently create a blocker, so an error
  // here rejects the candidate: with a base rate this low, a wrong positive costs more than a miss.
  try {
    const verdict = await verifyBlocker(transcript, blocker, quote);
    if (!verdict.confirmed) {
      console.log(`[dealBlocker] "${blocker}" rejected by verifier: ${verdict.reason?.slice(0, 120)}`);
      return { blocker: NO_BLOCKER, quote: null, start: null, end: null };
    }
  } catch (err) {
    console.error(`[dealBlocker] verification failed, rejecting "${blocker}": ${err.message}`);
    return { blocker: NO_BLOCKER, quote: null, start: null, end: null };
  }

  return { blocker, quote, start: hit.start, end: hit.end };
}

export { detectDealBlocker, DEAL_BLOCKERS, NO_BLOCKER, BLOCKER_LABELS, BLOCKER_COLUMNS };
