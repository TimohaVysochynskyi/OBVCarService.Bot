import { httpError } from './errors.js';

// Мережеві запити з ТАЙМАУТОМ і тегом «до кого ми йшли».
//
// До цього жоден `fetch` у проєкті не мав обмеження часу. Зависання апстріму не давало ні
// помилки, ні відповіді: у боті хендлер висів, поки людина дивилась на «друкує…», а в інжесті
// pm2 через 15 хвилин убивав прогін посеред роботи. Показати таке зависання неможливо в принципі
// — його спершу треба перетворити на помилку.
//
// Друга задача — тег. `fetch` кидає `TypeError('fetch failed')`, у якому немає ні хоста, ні
// операції; такий текст і летів у Telegram. Тепер помилка несе provider/op, тому клас виходить
// точним (`OAI-NET`, `BIN-TIMEOUT`) замість загального `NET`.

// Скільки чекати. Значення різні, бо різна природа роботи: транскрипція довгого дзвінка — це
// хвилини, а список дзвінків Binotel мусить прийти за секунди.
const DEFAULT_TIMEOUT_MS = {
  binotel: 30_000,
  telegram: 30_000,
  openai: 120_000,
  recording: 120_000,
  elevenlabs: 300_000, // STT цілої розмови; ElevenLabs тримає зʼєднання весь час обробки
};

const FALLBACK_TIMEOUT_MS = 60_000;

function timeoutFor(provider, override) {
  if (override) return override;
  const fromEnv = Number(process.env.HTTP_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TIMEOUT_MS[provider] ?? FALLBACK_TIMEOUT_MS;
}

const isAbort = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

// Запит без перевірки статусу — для тих кількох місць, які самі розбирають відповідь (Binotel
// вміє віддавати помилку з HTTP 200; перевірка балансу ElevenLabs трактує 401 як стан, не збій).
async function fetchRaw(provider, op, url, init = {}, { timeoutMs } = {}) {
  const ms = timeoutFor(provider, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    const reason = isAbort(err) ? `немає відповіді за ${Math.round(ms / 1000)}с` : err?.message || 'збій мережі';
    const tagged = new Error(`${provider} ${op}: ${reason}`);
    tagged.provider = provider;
    tagged.op = op;
    tagged.cause = err;
    // Ім'я лишаємо розпізнаваним, щоб правило таймауту в core/errors.js влучало точно.
    if (isAbort(err)) tagged.name = 'TimeoutError';
    throw tagged;
  }
}

// Звичайний шлях: або Response з успішним статусом, або готова тегована помилка.
async function fetchOk(provider, op, url, init = {}, options = {}) {
  const res = await fetchRaw(provider, op, url, init, options);
  if (!res.ok) throw await httpError(provider, op, res);
  return res;
}

export { fetchOk, fetchRaw, DEFAULT_TIMEOUT_MS };
