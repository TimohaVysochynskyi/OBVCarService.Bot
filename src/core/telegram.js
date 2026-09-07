import { withRetry } from './retry.js';
import { fetchOk } from './http.js';
import { getRecipients } from './store.js';

const TELEGRAM_MAX_LENGTH = 4096;
const CHUNK_TARGET_LENGTH = 3800; // margin below the hard limit for safety

async function rawSend(token, chatId, text, parseMode) {
  const res = await fetchOk('telegram', 'надсилання повідомлення', `https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
  });
}

// Telegram hard-caps messages at 4096 chars - split on paragraph/line breaks so we don't
// cut a sentence (or a markdown entity) in half whenever possible.
function splitMessage(text) {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n\n', CHUNK_TARGET_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', CHUNK_TARGET_LENGTH);
    if (splitAt <= 0) splitAt = CHUNK_TARGET_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendChunk(token, chatId, text) {
  try {
    await withRetry(() => rawSend(token, chatId, text, 'Markdown'), {
      attempts: 2,
      delayMs: 1000,
      label: 'telegram send (markdown)',
    });
    console.log('[telegram] sent (markdown)');
  } catch (err) {
    console.error(`[telegram] markdown send failed, falling back to plain text: ${err.message}`);
    await withRetry(() => rawSend(token, chatId, text, undefined), {
      attempts: 2,
      delayMs: 1000,
      label: 'telegram send (plain)',
    });
    console.log('[telegram] sent (plain text fallback)');
  }
}

async function sendMessage(text, { chatId } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || !chatId) {
    console.log('[telegram] DRY RUN (no TELEGRAM_BOT_TOKEN or chatId) - would send:\n');
    console.log(text);
    console.log('\n[telegram] --- end of message ---');
    return;
  }

  const chunks = splitMessage(text);
  if (chunks.length > 1) {
    console.log(`[telegram] message is ${text.length} chars, splitting into ${chunks.length} messages`);
  }
  for (const [i, chunk] of chunks.entries()) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : '';
    await sendChunk(token, chatId, prefix + chunk);
  }
}

// Резервні отримувачі: кому писати, коли основний список недоступний або порожній.
//
// Це остання ланка, якої бракувало. Список отримувачів живе в `app_state`, тобто в тій самій
// базі, падіння якої і треба повідомити — тож `getRecipients` кидав, і алерт про недоступний
// Postgres не доходив НІКОМУ. Тепер у такому разі беруться id з env, і нічого налаштовувати не
// треба: `TELEGRAM_BOOTSTRAP_CHAT_IDS` (сід директорів) — це вже ті самі люди.
// ALERT_FALLBACK_CHAT_IDS дозволяє задати інший список, якщо потрібно.
function fallbackRecipients() {
  const raw = process.env.ALERT_FALLBACK_CHAT_IDS || process.env.TELEGRAM_BOOTSTRAP_CHAT_IDS || '';
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((id) => /^-?\d+$/.test(id))
    .map((id) => ({ id, name: id }));
}

// Alerts fan out to every recipient configured in the bot's /settings → "Сповіщення про поломки"
// (app_state.alert_recipients, managed by admins), and fall back to the env list above when that
// is unreachable or empty. With neither, the alert is still written to the log, never dropped
// silently. A failed send to one recipient doesn't block the others.
async function sendAlert(text, { icon = '⚠️' } = {}) {
  let recipients = [];
  let unreachable = false;
  try {
    recipients = await getRecipients('alert');
  } catch (err) {
    unreachable = true;
    console.error(`[telegram] список отримувачів недоступний: ${err.message}`);
  }

  let body = `${icon} ${text}`;
  if (!recipients.length) {
    recipients = fallbackRecipients();
    // Читач мусить знати, що це резервний шлях: інакше «алерт прийшов» виглядає як «усе гаразд,
    // просто одна поломка», хоча насправді не працює й сам список отримувачів.
    if (recipients.length && unreachable) {
      body +=
        '\n\n(надіслано резервним каналом — база даних недоступна, ' +
        'тож список отримувачів із налаштувань прочитати не вдалося)';
    }
  }

  if (!recipients.length) {
    console.warn('[telegram] немає ні отримувачів у налаштуваннях, ні резервних id - алерт лише в лозі:');
    console.warn(body);
    return;
  }

  for (const r of recipients) {
    try {
      await sendMessage(body, { chatId: r.id });
    } catch (err) {
      console.error(`[telegram] alert to ${r.id} failed: ${err.message}`);
    }
  }
}

export { sendMessage, sendAlert };
