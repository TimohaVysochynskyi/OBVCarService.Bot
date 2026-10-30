const MAX = 4096;
const TARGET = 3800;

const COPY_TARGET = 2800;

function splitMessage(text, target = TARGET, max = MAX) {
  if (text.length <= max) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > max) {
    let at = remaining.lastIndexOf('\n\n', target);
    if (at <= 0) at = remaining.lastIndexOf('\n', target);
    if (at <= 0) at = target;
    chunks.push(remaining.slice(0, at));
    remaining = remaining.slice(at).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendCopyable(api, chatId, text, { intro } = {}) {
  const chunks = splitMessage(String(text), COPY_TARGET, COPY_TARGET);
  const ids = [];
  for (const [i, chunk] of chunks.entries()) {
    const head = i === 0 && intro ? `${intro}\n\n` : '';
    const part = chunks.length > 1 ? `Частина ${i + 1} з ${chunks.length}\n` : '';
    const plain = `${head}${part}${chunk}`;
    let m = await api
      .sendMessage(chatId, `${escapeHtml(head + part)}<pre>${escapeHtml(chunk)}</pre>`, { parse_mode: 'HTML' })
      .catch(() => null);
    if (!m) m = await api.sendMessage(chatId, plain).catch(() => null);
    if (m?.message_id) ids.push(m.message_id);
  }
  return ids;
}

async function sendLong(api, chatId, text, { parseMode, replyMarkup, replyToMessageId } = {}) {
  const chunks = splitMessage(text);
  const replyParameters = replyToMessageId ? { message_id: replyToMessageId, allow_sending_without_reply: true } : undefined;
  const ids = [];
  for (const [i, chunk] of chunks.entries()) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : '';
    const body = prefix + chunk;
    const isLast = i === chunks.length - 1;
    const extra = {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(replyParameters ? { reply_parameters: replyParameters } : {}),
    };
    try {
      const m = await api.sendMessage(chatId, body, extra);
      if (m?.message_id) ids.push(m.message_id);
    } catch (err) {
      if (parseMode) {
        const m = await api.sendMessage(chatId, body, {
          ...(isLast && replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        });
        if (m?.message_id) ids.push(m.message_id);
      } else {
        throw err;
      }
    }
  }
  return ids;
}

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


const lastSentMsg = new Map();

function installMessageTracker(bot) {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    try {
      if (res.ok && typeof method === 'string' && method.startsWith('send') && payload && payload.chat_id != null) {
        const mid = res.result?.message_id;
        if (mid) lastSentMsg.set(String(payload.chat_id), mid);
      }
    } catch {
    }
    return res;
  });
}

const isNotModified = (err) => (err?.description || err?.message || '').includes('message is not modified');

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
        await ctx.editMessageText(text, { reply_markup: kb });
        ctx.session.screenId = clicked;
        return;
      } catch (err2) {
        if (isNotModified(err2)) { ctx.session.screenId = clicked; return; }
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
  for (const id of new Set([clicked, prevScreen])) {
    if (id && id !== msg.message_id) await ctx.api.deleteMessage(ctx.chat.id, id).catch(() => {});
  }
  return msg;
}

export { splitMessage, sendLong, sendCopyable, withProgress, showScreen, installMessageTracker };
