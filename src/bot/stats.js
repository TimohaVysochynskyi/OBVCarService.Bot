import { InlineKeyboard, Keyboard } from 'grammy';
import { getOperators, getOperatorStats, getBucketedTrend } from '../core/store.js';
import { operatorListKeyboard, periodKeyboard, operatorLabel } from './keyboards.js';
import { displayName, formatPhone } from './operators.js';
import { deliverManagerReport } from './report.js';
import { buildDynamicsText, MAX_BUCKETS } from './dynamics.js';
import { periodRange, formatKyiv } from './time.js';
import { showScreen, withProgress } from './ui.js';

const MODE_BY_PERIOD = { day: 'daily', week: 'range', month: 'range', quarter: 'range_reuse' };

async function statsPicker() {
  const operators = await getOperators();
  if (!operators.length) {
    return { text: 'Поки немає оброблених дзвінків.', kb: new InlineKeyboard().text('« Назад до меню', 'menu') };
  }
  return { text: '📊 Оберіть менеджера:', kb: operatorListKeyboard(operators, 'stat') };
}

async function showDynamics(ctx, name, bucket) {
  const buckets = await getBucketedTrend(name, bucket, MAX_BUCKETS);
  const text = buildDynamicsText(name, bucket, buckets);
  const tick = (b) => (b === bucket ? ' ✓' : '');
  const kb = new InlineKeyboard()
    .text(`📅 Тижні${tick('week')}`, `stat:dyn:week:${name}`)
    .text(`🗓 Місяці${tick('month')}`, `stat:dyn:month:${name}`)
    .row()
    .text('📊 Звіт за період →', `stat:rep:${name}`)
    .row()
    .text('« Назад до меню', 'menu')
    .text('« Менеджери', 'stat:pick');
  await showScreen(ctx, text, kb);
}

function registerStats(bot) {
  bot.callbackQuery('stat:pick', async (ctx) => {
    const { text, kb } = await statsPicker();
    await ctx.answerCallbackQuery();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery(/^stat:op:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDynamics(ctx, ctx.match[1], 'week');
  });

  bot.callbackQuery(/^stat:dyn:(week|month):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDynamics(ctx, ctx.match[2], ctx.match[1]);
  });

  bot.callbackQuery(/^stat:rep:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    await ctx.answerCallbackQuery();
    await showScreen(ctx, `${operatorLabel(name)} — звіт за період:`, periodKeyboard((p) => `stat:go:${p}:${name}`, `stat:op:${name}`));
  });

  bot.callbackQuery(/^stat:go:(day|week|month|quarter):(.+)$/, async (ctx) => {
    const period = ctx.match[1];
    const name = ctx.match[2];
    const { start, end } = periodRange(period);
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('« Періоди', `stat:rep:${name}`)
      .text('📈 Динаміка', `stat:op:${name}`)
      .row()
      .text('« Назад до меню', 'menu');
    const res = await withProgress(
      ctx.api,
      ctx.chat.id,
      'typing',
      () => deliverManagerReport(ctx.api, ctx.chat.id, name, start, end, { mode: MODE_BY_PERIOD[period] }),
      { notice: '⏳ Формую доказовий звіт: аналізую дзвінки періоду, це може зайняти до хвилини…' }
    );
    if (res.empty) {
      await showScreen(ctx, `${operatorLabel(name)}\n\nНемає оброблених дзвінків за період.`, kb);
      return;
    }
    await showScreen(ctx, `${operatorLabel(name)} — дії:`, kb);
  });

  registerMyStats(bot);
}


async function openMyReport(ctx) {
  ctx.session.awaiting = null;
  if (!ctx.botUser?.operatorName) {
    await ctx.reply('Ваш акаунт ще не звʼязано з оператором. Зверніться до директора, щоб він привʼязав вас.');
    return;
  }
  await showScreen(ctx, '📊 Моя статистика — оберіть період:', periodKeyboard((p) => `me:go:${p}`, 'menu'));
}

function registerMyStats(bot) {
  bot.callbackQuery('me:pick', async (ctx) => {
    await ctx.answerCallbackQuery();
    await openMyReport(ctx);
  });

  bot.callbackQuery(/^me:go:(day|week|month|quarter)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const name = ctx.botUser?.operatorName;
    if (!name) {
      await ctx.reply('Ваш акаунт ще не звʼязано з оператором. Зверніться до директора.');
      return;
    }
    const period = ctx.match[1];
    const { start, end, label } = periodRange(period);
    const s = await getOperatorStats(name, start, end);
    const sales = s.salesCount ?? 0;
    const info = s.infoCount ?? 0;
    const reachable = s.reachableCount == null ? sales : s.reachableCount;
    const rate = reachable ? Math.round((s.successCount / reachable) * 100) : 0;
    const blockedLine = s.blockedCount
      ? `\nНезакриті не з вини менеджера: *${s.blockedCount}* (не враховані в конверсії)`
      : '';
    const phone = ctx.botUser?.phone ? formatPhone(ctx.botUser.phone) : 'не збережено';
    const header =
      `📊 *Моя статистика* — ${label}\n` +
      `_${formatKyiv(start)} – ${formatKyiv(end)}_\n\n` +
      `Оператор: *${displayName(name)}*\n` +
      `Телефон: ${phone}\n\n` +
      `Дзвінків: *${s.callCount}* (угод: ${sales}, інформаційних: ${info})\n` +
      `Записів: *${s.successCount}* з ${reachable} угод (${rate}%)\n` +
      `Середній бал (угоди): *${s.avgScore ?? '—'}*\n` +
      `Найслабший етап (угоди): *${s.topWeakStage ?? '—'}*${blockedLine}`;
    const kb = new InlineKeyboard()
      .text('☎️ Оновити мій номер', 'me:phone')
      .row()
      .text('« Назад до меню', 'menu')
      .text('« Період', 'me:pick');
    const body = s.callCount ? header : `${header}\n\n_Немає дзвінків за період._`;
    await showScreen(ctx, body, kb);
  });

  bot.callbackQuery('me:phone', async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.awaiting = { type: 'save_phone' };
    await ctx.reply('Натисніть кнопку нижче, щоб зберегти свій номер телефону.', {
      reply_markup: new Keyboard().requestContact('📱 Поділитися моїм номером').row().text('✖️ Скасувати').resized().oneTime(),
    });
  });
}

export { registerStats, statsPicker, openMyReport };
