import { InlineKeyboard } from 'grammy';
import { listErrorLog, summarizeErrorLog, getErrorLogByIncident } from '../core/store.js';
import { LOG } from '../core/errorTexts.js';
import { showScreen, sendLong } from './ui.js';
import { formatKyiv } from './time.js';

// Екран «🩺 Журнал» (`/log`, admin) — журнал інцидентів у самому боті.
//
// Це пряма відповідь на «щоб клієнт міг передати інфу розробнику». До цього повна правда була
// лише в логах pm2 на VPS, тобто за SSH: клієнт не міг ні побачити її, ні переслати. Тепер
// достатньо коду інциденту з повідомлення про помилку.
//
// Тексти — у core/errorTexts.js (розділ LOG), як і решта текстів про помилки.

const SUMMARY_DAYS = 7;
const RECENT_LIMIT = 8;

// Час у моноширинному вигляді для кнопки: «07.09 16:20». formatKyiv дає повну дату - для кнопки
// вона задовга, а секунди тут не потрібні.
function buttonTime(at) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at));
}

const SOURCE_LABEL = { bot: 'бот', poll: 'збір дзвінків' };

async function summaryScreen() {
  const since = new Date(Date.now() - SUMMARY_DAYS * 24 * 3600 * 1000);
  const [summary, recent] = await Promise.all([summarizeErrorLog(since), listErrorLog(RECENT_LIMIT)]);

  if (!recent.length) {
    return { text: LOG.empty(SUMMARY_DAYS), kb: new InlineKeyboard().text('« Назад до меню', 'menu') };
  }

  const total = summary.reduce((n, row) => n + row.count, 0);
  const lines = [LOG.title, '', LOG.period(SUMMARY_DAYS, total), ''];
  // Згруповано за класом: «OAI-QUOTA — 9 разів» одразу показує, це поодинокий випадок чи патерн.
  for (const row of summary) lines.push(LOG.summaryRow(row.code, row.count, buttonTime(row.lastAt)));
  lines.push('', LOG.pickHint);

  const kb = new InlineKeyboard();
  for (const row of recent) {
    kb.text(`${buttonTime(row.at)} · ${row.code}`, `log:i:${row.incident}`).row();
  }
  kb.text('« Назад до меню', 'menu');
  // Простим текстом: технічні рядки й назви файлів рясніють _ * [, і Markdown на них падає.
  return { text: lines.join('\n'), kb, parseMode: null };
}

function incidentScreen(row) {
  const lines = [
    LOG.incidentTitle(row.incident),
    '',
    LOG.fieldCode(row.code),
    LOG.fieldWhen(formatKyiv(new Date(row.at))),
    LOG.fieldWhere(SOURCE_LABEL[row.process] || row.process, row.feature || '—'),
  ];
  if (row.telegramId) lines.push(LOG.fieldWho(row.telegramId));
  if (row.context && Object.keys(row.context).length) {
    const meaningful = Object.entries(row.context).filter(([, v]) => v != null && v !== '');
    if (meaningful.length) lines.push(LOG.fieldContext(meaningful.map(([k, v]) => `${k}=${v}`).join(', ')));
  }
  lines.push('', row.technical || row.message || '—');

  const kb = new InlineKeyboard()
    .text(LOG.copyButton, `log:c:${row.incident}`)
    .row()
    .text('« Назад до меню', 'menu')
    .text('« Журнал', 'log');
  return { text: lines.join('\n'), kb, parseMode: null };
}

// Готовий блок на пересилання. Окремим повідомленням і без розмітки — щоб його можна було
// затиснути й переслати одним рухом, не вибираючи з-під кнопок.
function copyBlock(row) {
  return [
    LOG.copyHeader(row.incident),
    `код: ${row.code}`,
    `час: ${new Date(row.at).toISOString()}`,
    `процес: ${row.process}`,
    `дія: ${row.feature || '—'}`,
    row.telegramId ? `telegram_id: ${row.telegramId}` : null,
    row.context ? `контекст: ${JSON.stringify(row.context)}` : null,
    '',
    row.technical || row.message || '—',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

async function openIncidents(ctx) {
  const { text, kb, parseMode } = await summaryScreen();
  await showScreen(ctx, text, kb, { parseMode });
}

function registerIncidents(bot) {
  bot.callbackQuery('log', async (ctx) => {
    await ctx.answerCallbackQuery();
    await openIncidents(ctx);
  });

  bot.callbackQuery(/^log:i:([0-9A-Z]{4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const row = await getErrorLogByIncident(ctx.match[1]);
    if (!row) {
      await showScreen(ctx, LOG.notFound(ctx.match[1]), new InlineKeyboard().text('« Журнал', 'log'), {
        parseMode: null,
      });
      return;
    }
    const { text, kb, parseMode } = incidentScreen(row);
    await showScreen(ctx, text, kb, { parseMode });
  });

  bot.callbackQuery(/^log:c:([0-9A-Z]{4})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const row = await getErrorLogByIncident(ctx.match[1]);
    if (!row) {
      await ctx.reply(LOG.notFound(ctx.match[1]));
      return;
    }
    await sendLong(ctx.api, ctx.chat.id, copyBlock(row));
    await ctx.reply(LOG.copyHint);
  });
}

export { registerIncidents, openIncidents, copyBlock, incidentScreen };
