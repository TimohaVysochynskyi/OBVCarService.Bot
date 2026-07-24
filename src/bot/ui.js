const MAX = 4096;
const TARGET = 3800;

// Split on paragraph/line breaks so we don't cut a sentence (or a markdown entity) in half.
function splitMessage(text) {
  if (text.length <= MAX) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let at = remaining.lastIndexOf('\n\n', TARGET);
    if (at <= 0) at = remaining.lastIndexOf('\n', TARGET);
    if (at <= 0) at = TARGET;
    chunks.push(remaining.slice(0, at));
    remaining = remaining.slice(at).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Send arbitrarily long text, splitting into <=4096-char messages. When parseMode is set and
// Telegram rejects the entity markup, resend that chunk as plain text so nothing is lost.
// replyMarkup (optional) is attached to the LAST chunk only (a keyboard makes sense on one message).
async function sendLong(api, chatId, text, { parseMode, replyMarkup } = {}) {
  const chunks = splitMessage(text);
  for (const [i, chunk] of chunks.entries()) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : '';
    const body = prefix + chunk;
    const isLast = i === chunks.length - 1;
    const extra = { ...(parseMode ? { parse_mode: parseMode } : {}), ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}) };
    try {
      await api.sendMessage(chatId, body, extra);
    } catch (err) {
      if (parseMode) {
        await api.sendMessage(chatId, body, isLast && replyMarkup ? { reply_markup: replyMarkup } : {});
      } else {
        throw err;
      }
    }
  }
}

// Telegram chat actions ('typing', 'upload_voice', 'upload_document', …) auto-expire after ~5s.
// For a slow operation (transcription, embeddings, report generation, audio download) re-send
// the action every 4s so the "…друкує / надсилає файл" indicator stays visible the whole time,
// then clear it. Returns whatever fn() resolves to (and propagates its errors).
//
// Pass { notice } to also post a persistent text message ("Бот обробляє запит…") for the whole
// operation — the typing indicator alone is subtle and vanishes between the 4s ticks, so a plain
// message reassures the user that a long request is in progress. The notice is deleted in the
// finally block, so it disappears the moment the operation finishes (success or error).
async function withProgress(api, chatId, action, fn, { notice } = {}) {
  await api.sendChatAction(chatId, action).catch(() => {});
  let noticeMsgId = null;
  if (notice) {
    const m = await api.sendMessage(chatId, notice).catch(() => null);
    noticeMsgId = m?.message_id ?? null;
  }
  const timer = setInterval(() => {
    api.sendChatAction(chatId, action).catch(() => {});
  }, 4000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    if (noticeMsgId != null) await api.deleteMessage(chatId, noticeMsgId).catch(() => {});
  }
}

// --- Single "active screen" model ----------------------------------------------------------
// The interactive menu should live in the NEWEST message so the user's focus (bottom of the
// chat) matches what they're navigating. Best practice is to edit the menu in place (smooth, no
// clutter) — but only while it IS the newest message. Once content (a transcript, an answer, the
// prompt text) is sent below it, editing that now-stranded menu changes something scrolled up,
// which is confusing. So: edit in place when the tapped menu is still the last message; otherwise
// send a fresh menu at the bottom and delete the stranded one. Keeps navigation always in focus.

// chatId -> message_id of the last message THIS bot sent there (filled by installMessageTracker).
const lastSentMsg = new Map();

// Register an API transformer that records every outgoing message's id, so showScreen can tell
// whether a tapped menu is still at the bottom. Call once at startup: installMessageTracker(bot).
function installMessageTracker(bot) {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    try {
      if (res.ok && typeof method === 'string' && method.startsWith('send') && payload && payload.chat_id != null) {
        const mid = res.result?.message_id;
        if (mid) lastSentMsg.set(String(payload.chat_id), mid);
      }
    } catch {
      /* tracking must never break a send */
    }
    return res;
  });
}

const isNotModified = (err) => (err?.description || err?.message || '').includes('message is not modified');

// Render an interactive screen (menu / picker / list). From a callback it edits in place when the
// tapped message is still the newest; otherwise (or from a command) it sends a fresh screen at the
// bottom and removes the previous one, so the active menu is never stranded above later content.
// parseMode defaults to Markdown; pass { parseMode: null } for screens whose text may contain raw
// _ * [ (e.g. filenames) — see kb.js. Tracks the active screen's id in ctx.session.screenId.
async function showScreen(ctx, text, kb, { parseMode = 'Markdown' } = {}) {
  const chatKey = String(ctx.chat.id);
  const clicked = ctx.callbackQuery?.message?.message_id;
  const extra = parseMode ? { parse_mode: parseMode, reply_markup: kb } : { reply_markup: kb };

  if (clicked != null && lastSentMsg.get(chatKey) === clicked) {
    try {
      await ctx.editMessageText(text, extra);
      ctx.session.screenId = clicked;
      return;
    } catch (err) {
      if (isNotModified(err)) { ctx.session.screenId = clicked; return; }
      try {
        await ctx.editMessageText(text, { reply_markup: kb }); // markdown broke -> plain
        ctx.session.screenId = clicked;
        return;
      } catch (err2) {
        if (isNotModified(err2)) { ctx.session.screenId = clicked; return; }
        /* edit truly failed -> resend at the bottom */
      }
    }
  }

  const prevScreen = ctx.session?.screenId;
  let msg;
  try {
    msg = await ctx.reply(text, extra);
  } catch {
    msg = await ctx.reply(text, { reply_markup: kb });
  }
  if (ctx.session) ctx.session.screenId = msg.message_id;
  // Remove the stranded menu(s): the tapped one and/or the previously tracked screen.
  for (const id of new Set([clicked, prevScreen])) {
    if (id && id !== msg.message_id) await ctx.api.deleteMessage(ctx.chat.id, id).catch(() => {});
  }
  return msg;
}

export { splitMessage, sendLong, withProgress, showScreen, installMessageTracker };
