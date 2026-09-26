import { withRetry } from './retry.js';
import { fetchOk } from './http.js';
import { getRecipients } from './store.js';

const TELEGRAM_MAX_LENGTH = 4096;
const CHUNK_TARGET_LENGTH = 3800;

async function rawSend(token, chatId, text, parseMode) {
  const res = await fetchOk('telegram', 'надсилання повідомлення', `https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
  });
}

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

function fallbackRecipients() {
  const raw = process.env.ALERT_FALLBACK_CHAT_IDS || process.env.TELEGRAM_BOOTSTRAP_CHAT_IDS || '';
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((id) => /^-?\d+$/.test(id))
    .map((id) => ({ id, name: id }));
}

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
