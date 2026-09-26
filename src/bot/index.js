import 'dotenv/config';
import { Bot, session } from 'grammy';
import {
  migrate,
  migrateKb,
  activatePendingByPhone,
  setBotUserPhone,
  normalizePhone,
} from '../core/store.js';
import { mainMenu } from './keyboards.js';
import { registerStats, statsPicker, openMyReport } from './stats.js';
import { registerArchive, archivePicker } from './archive.js';
import { registerKnowledgeBase, answerQuestion, sendAnswerSources, promptQuestion, openFiles, openKbDocById } from './kb.js';
import { sendManualReport, startScheduler, registerReportActions } from './report.js';
import { registerPrompt, openPromptMenu, savePromptText } from './prompt.js';
import { registerRoles, openRolesMenu, addByPhoneText } from './roles.js';
import { registerSettings, openSettings, addRecipientByIdText } from './settings.js';
import { registerIncidents, openIncidents } from './incidents.js';
import { registerHealth, openHealth } from './health.js';
import { registerGlobalReport } from './globalReport.js';
import { formatPhone } from './operators.js';
import {
  getUser,
  canAccess,
  featureOf,
  isAdmin,
  ROLES,
  ROLE_LABELS,
  invalidateRole,
  seedDirectors,
} from './access.js';
import { sendLong, withProgress, showScreen, installMessageTracker } from './ui.js';
import { errorGuard, installBotCatch, registerErrorActions, reportToUser } from './errorReply.js';
import { installProcessTraps } from '../core/processTraps.js';
import { startHeartbeat, checkPollerAlive } from '../core/liveness.js';
import { describeError } from '../core/errors.js';
import { recordError } from '../core/errorLog.js';
import { sendAlert } from '../core/telegram.js';
import { alertText } from '../core/alerts.js';

const kbState = { ready: false };

installProcessTraps('bot');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set - put the token of the clean bot from @BotFather there');
}

const bot = new Bot(token);
installMessageTracker(bot);

bot.use(session({ initial: () => ({ awaiting: null, screenId: null }) }));

bot.use(errorGuard);

const cancelKeyboard = () => ({ remove_keyboard: true });
const isCancel = (t) => /^\s*(✖️|❌)?\s*скасувати\b/i.test(t || '');

bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  const user = await getUser(id);

  if (user && user.status === 'active') {
    ctx.botUser = user;
    ctx.role = user.role;
    const feature = featureOf(ctx);
    if (feature && !canAccess(user.role, feature)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '⛔ Немає доступу до цієї функції', show_alert: true }).catch(() => {});
      else await ctx.reply('⛔ Ця функція недоступна для вашої ролі.').catch(() => {});
      return;
    }
    return next();
  }

  const contact = ctx.message?.contact;
  if (contact && (contact.user_id == null || contact.user_id === id)) {
    const activated = await activatePendingByPhone(contact.phone_number, {
      telegramId: id,
      username: ctx.from?.username,
      displayName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null,
    });
    if (activated) {
      invalidateRole(id);
      await ctx.reply(`✅ Доступ надано. Ваша роль: ${ROLE_LABELS[activated.role]}.`, { reply_markup: cancelKeyboard() });
      await setCommandsForRole(ctx.api, id, activated.role);
      await showScreen(ctx, 'Оберіть дію:', mainMenu(activated.role));
      return;
    }
    await ctx.reply('Вашого номера немає серед запрошених. Зверніться до директора, щоб він вас додав.', {
      reply_markup: cancelKeyboard(),
    });
    return;
  }

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: '⛔ Немає доступу', show_alert: true }).catch(() => {});
  } else {
    await ctx
      .reply(
        `⛔ Немає доступу до цього бота.\nВаш ID: ${id ?? '—'}\n\n` +
          'Якщо ви співробітник — поділіться своїм номером кнопкою нижче, щоб увійти (директор має вас попередньо додати).',
        { reply_markup: { keyboard: [[{ text: '📱 Поділитися номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
      )
      .catch(() => {});
  }
});

const CMD = {
  menu: { command: 'menu', description: '☰ Головне меню' },
  stats: { command: 'stats', description: '📊 Статистика менеджера' },
  archive: { command: 'archive', description: '🗂 Архів розмов' },
  ask: { command: 'ask', description: '📚 База знань' },
  files: { command: 'files', description: '📁 Файли (база знань)' },
  report: { command: 'report', description: '🔄 Звіт зараз' },
  prompt: { command: 'prompt', description: '🧠 Промпти AI' },
  roles: { command: 'roles', description: '👥 Ролі' },
  settings: { command: 'settings', description: '⚙️ Налаштування' },
  myreport: { command: 'myreport', description: '📊 Моя статистика' },
  log: { command: 'log', description: '🩺 Журнал інцидентів' },
  health: { command: 'health', description: '🩺 Перевірка стану' },
  globalReport: { command: 'globalreport', description: '📊 Звіт за весь період' },
};

function commandsForRole(role) {
  if (isAdmin(role))
    return [CMD.menu, CMD.stats, CMD.archive, CMD.ask, CMD.files, CMD.report, CMD.prompt, CMD.roles, CMD.settings, CMD.log, CMD.health, CMD.globalReport];
  if (role === ROLES.MANAGER) return [CMD.menu, CMD.myreport, CMD.ask];
  return [CMD.menu, CMD.ask];
}

async function setCommandsForRole(api, chatId, role) {
  await api
    .setMyCommands(commandsForRole(role), { scope: { type: 'chat', chat_id: chatId } })
    .catch((e) => console.error(`[bot] setMyCommands(chat) failed: ${e.message}`));
}

async function openMenu(ctx) {
  ctx.session.awaiting = null;
  await setCommandsForRole(ctx.api, ctx.chat.id, ctx.role);
  await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
}

async function openStats(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = await statsPicker();
  await showScreen(ctx, text, kb);
}

async function openArchive(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = await archivePicker();
  await showScreen(ctx, text, kb);
}

async function openAsk(ctx) {
  await promptQuestion(ctx, kbState);
}

async function openFilesMenu(ctx) {
  ctx.session.awaiting = null;
  await openFiles(ctx, kbState);
}

async function runReport(ctx) {
  await sendManualReport(ctx.api, ctx.chat.id);
  await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
}

bot.command('start', async (ctx) => {
  const payload = (ctx.match || '').trim();
  const kbDoc = /^kbdoc_(\d+)$/.exec(payload);
  if (kbDoc) {
    await openKbDocById(ctx, Number(kbDoc[1]), ctx.role);
    return;
  }
  await ctx.reply('Вітаю! Керування — кнопкою «Menu» біля поля вводу або в меню нижче.', {
    reply_markup: { remove_keyboard: true },
  });
  await openMenu(ctx);
});
bot.command('menu', openMenu);
bot.command('stats', openStats);
bot.command('archive', openArchive);
bot.command('ask', openAsk);
bot.command('files', openFilesMenu);
bot.command('prompt', openPromptMenu);
bot.command('report', runReport);
bot.command('roles', openRolesMenu);
bot.command('settings', openSettings);
bot.command('log', openIncidents);
bot.command('health', (ctx) => openHealth(ctx, kbState));
bot.command('myreport', openMyReport);

bot.callbackQuery('menu', async (ctx) => {
  ctx.session.awaiting = null;
  await ctx.answerCallbackQuery();
  await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
});

bot.callbackQuery('report:now', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Генерую звіт…' });
  await runReport(ctx);
});

registerStats(bot);
registerArchive(bot);
registerKnowledgeBase(bot, kbState);
registerPrompt(bot);
registerRoles(bot);
registerSettings(bot);
registerReportActions(bot);
registerErrorActions(bot);
registerIncidents(bot);
registerHealth(bot, kbState);
registerGlobalReport(bot);

bot.on('message:contact', async (ctx) => {
  const st = ctx.session.awaiting;
  if (st?.type !== 'save_phone') return;
  const c = ctx.message.contact;
  if (c.user_id != null && c.user_id !== ctx.from.id) {
    await ctx.reply('Поділіться, будь ласка, СВОЇМ номером.');
    return;
  }
  await setBotUserPhone(ctx.from.id, c.phone_number);
  invalidateRole(ctx.from.id);
  ctx.session.awaiting = null;
  await ctx.reply(`✅ Номер збережено: ${formatPhone(c.phone_number)}.`, { reply_markup: { remove_keyboard: true } });
  await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
});

bot.on('message:text', async (ctx) => {
  const st = ctx.session.awaiting;

  if (st && isCancel(ctx.message.text)) {
    ctx.session.awaiting = null;
    await ctx.reply('Скасовано.', { reply_markup: { remove_keyboard: true } });
    await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
    return;
  }

  if (st?.type === 'role_add') {
    await addByPhoneText(ctx, st.role);
    return;
  }

  if (st?.type === 'settings_add') {
    await addRecipientByIdText(ctx, st.kind);
    return;
  }

  if (st?.type === 'save_phone') {
    await ctx.reply('Скористайтеся кнопкою «📱 Поділитися моїм номером» нижче, або « Скасувати.');
    return;
  }

  if (st?.type === 'prompt') {
    await savePromptText(ctx, st.key, ctx.message.text);
    return;
  }

  if (st?.type === 'kb_question') {
    try {
      const { text, sources } = await withProgress(
        ctx.api,
        ctx.chat.id,
        'typing',
        () => answerQuestion(ctx.message.text, ctx.role),
        { notice: '⏳ Бот обробляє запит, це може зайняти деякий час…' }
      );
      const ids = await sendLong(ctx.api, ctx.chat.id, text);
      if (sources.length) {
        await withProgress(ctx.api, ctx.chat.id, 'upload_document', () =>
          sendAnswerSources(ctx.api, ctx.chat.id, sources, { replyToMessageId: ids[0] })
        );
      }
    } catch (err) {
      await reportToUser(ctx, err, { action: 'kb_ask' });
    }
    await ctx.reply('Ще питання? Напишіть його наступним повідомленням, або відкрийте /menu, щоб вийти.');
    return;
  }

  await ctx.reply('Скористайтеся кнопкою «Menu» біля поля вводу або командою /menu.');
});

installBotCatch(bot);

async function main() {
  await migrate();

  const seeded = await seedDirectors();
  console.log(`[bot] seeded ${seeded} director(s) from env`);

  try {
    await migrateKb();
    kbState.ready = true;
    console.log('[bot] knowledge base ready (pgvector)');
  } catch (err) {
    console.error(`[bot] knowledge base DISABLED: ${err.message}`);
  }

  await bot.api
    .setMyCommands([CMD.menu, CMD.ask])
    .catch((e) => console.error(`[bot] setMyCommands failed: ${e.message}`));
  await bot.api
    .setChatMenuButton({ menu_button: { type: 'commands' } })
    .catch((e) => console.error(`[bot] setChatMenuButton failed: ${e.message}`));

  startScheduler(bot.api);

  startHeartbeat('bot');
  setInterval(() => {
    checkPollerAlive().catch((e) => console.error(`[bot] poller liveness check failed: ${e.message}`));
  }, 5 * 60 * 1000);

  await bot.start({
    onStart: (info) => console.log(`[bot] @${info.username} started (long polling)`),
  });
}

main().catch(async (err) => {
  const described = describeError(err, { action: 'startup', icon: '⚠️' });
  console.error(`[bot] ${described.code} інцидент ${described.incident}: ${described.technicalLine}`);
  console.error(err);
  await recordError(described, { source: 'bot', feature: 'startup' });
  await sendAlert(alertText(described)).catch((e) =>
    console.error(`[bot] не вдалося надіслати алерт про старт: ${e.message}`)
  );
  process.exit(1);
});
