import { InlineKeyboard } from 'grammy';
import { describeError } from '../core/errors.js';
import { recordError, lookupIncident } from '../core/errorLog.js';
import { UI } from '../core/errorTexts.js';
import { sendLong } from './ui.js';
import { featureOf } from './access.js';


const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;
const DETAILS_MAX = 300;
const details = new Map();

function remember(incident, code, technical) {
  details.set(incident, { code, at: Date.now(), technical });
  for (const [key, value] of details) {
    if (details.size <= DETAILS_MAX && Date.now() - value.at < DETAILS_TTL_MS) break;
    details.delete(key);
  }
}

function recall(incident) {
  const found = details.get(incident);
  if (!found) return null;
  if (Date.now() - found.at >= DETAILS_TTL_MS) {
    details.delete(incident);
    return null;
  }
  return found;
}

const CALLBACK_ACTIONS = [
  [/^arch:play:/, 'archive_audio'],
  [/^report:(exp|phr):/, 'report_details'],
  [/^stat:go:/, 'report'],
];

const AWAITING_ACTIONS = {
  kb_question: 'kb_ask',
  prompt: 'prompt',
  role_add: 'roles',
  settings_add: 'settings',
  save_phone: 'phone',
};

function actionOf(ctx) {
  const cq = ctx.callbackQuery?.data;
  if (cq) {
    for (const [re, action] of CALLBACK_ACTIONS) if (re.test(cq)) return action;
  }
  const awaiting = ctx.session?.awaiting?.type;
  if (awaiting && AWAITING_ACTIONS[awaiting]) return AWAITING_ACTIONS[awaiting];
  if (ctx.message?.document) return 'kb_edit';
  return featureOf(ctx) || 'fallback';
}


async function reportToUser(ctx, err, { action, subject } = {}) {
  const resolved = action || actionOf(ctx);
  const described = describeError(err, { action: resolved, subject });
  remember(described.incident, described.code, described.technical);
  await recordError(described, {
    source: 'bot',
    feature: resolved,
    telegramId: ctx.from?.id,
    context: {
      chatId: ctx.chat?.id ?? null,
      callback: ctx.callbackQuery?.data ?? null,
      awaiting: ctx.session?.awaiting?.type ?? null,
      subject: subject ?? null,
    },
  });

  console.error(
    `[bot] ${described.code} інцидент ${described.incident} (${resolved}, chat ${ctx.chat?.id ?? '—'}): ` +
      `${described.technicalLine}\n${described.technical}`
  );

  if (ctx.callbackQuery) {
    await ctx
      .answerCallbackQuery({ text: described.text.split('\n')[0].slice(0, 190) })
      .catch(() => {});
  }

  const chatId = ctx.chat?.id;
  if (chatId == null) return described;

  const keyboard = new InlineKeyboard()
    .text(UI.detailsButton, `err:d:${described.incident}`)
    .row()
    .text('« Назад до меню', 'menu');

  await sendLong(ctx.api, chatId, described.text, { replyMarkup: keyboard }).catch((sendErr) => {
    console.error(`[bot] не вдалося доставити повідомлення про помилку: ${sendErr.message}`);
  });
  return described;
}

async function errorGuard(ctx, next) {
  try {
    await next();
  } catch (err) {
    await reportToUser(ctx, err);
  }
}

function installBotCatch(bot) {
  bot.catch(async (botErr) => {
    const err = botErr?.error ?? botErr;
    const ctx = botErr?.ctx;
    if (!ctx) {
      console.error(`[bot] помилка без контексту: ${err?.message || err}`);
      return;
    }
    try {
      await reportToUser(ctx, err);
    } catch (inner) {
      console.error(`[bot] помилка в обробнику помилок: ${inner.message}`);
    }
  });
}

function registerErrorActions(bot) {
  bot.callbackQuery(/^err:d:([0-9A-Z]{4})$/, async (ctx) => {
    const incident = ctx.match[1];
    await ctx.answerCallbackQuery();
    const found = recall(incident) || (await lookupIncident(incident));
    if (!found?.technical) {
      await ctx.reply(UI.detailsGone);
      return;
    }
    await sendLong(
      ctx.api,
      ctx.chat.id,
      `${UI.detailsTitle(found.code, incident)}\n\n${found.technical}`
    );
  });
}

export { errorGuard, installBotCatch, registerErrorActions, reportToUser, actionOf };
