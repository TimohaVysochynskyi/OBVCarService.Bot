import { InlineKeyboard } from 'grammy';
import { getScoreRubricInfo, resetScoreRubric } from '../core/classifyCall.js';
import { sendLong, showScreen } from './ui.js';

// Owner-facing management of the communication-score rubric — the tunable criteria by which each
// call's communicationScore (1-10) is judged. View / edit / reset; the effective rubric lives in
// app_state.score_rubric (classifyCall reads it, falling back to its built-in DEFAULT_SCORE_RUBRIC).
// Admin-only (director/marketer), native /rubric command. Mirrors the /prompt (analysis prompt) flow.
// NOTE: this tunes ONLY the wording of the score criteria; the stage taxonomy (core/stages.js) is
// fixed and deliberately NOT editable here.

function rubricMenu() {
  return new InlineKeyboard()
    .text('👁 Переглянути поточну', 'rubric:view')
    .row()
    .text('✏️ Змінити', 'rubric:edit')
    .row()
    .text('↩️ Скинути до стандартної', 'rubric:reset')
    .row()
    .text('« Меню', 'menu');
}

// { text, kb } for the management screen — shared by the /rubric command (new message) and the
// callbacks that return to it (edit in place).
async function rubricScreen() {
  const { isCustom } = await getScoreRubricInfo();
  const status = isCustom
    ? '✏️ Зараз використовується *власна* рубрика.'
    : '📄 Зараз використовується *стандартна* рубрика.';
  const text =
    '⭐ *Рубрика оцінки комунікації*\n\n' +
    `${status}\n\n` +
    'За цими критеріями AI виставляє кожному дзвінку бал комунікації (1-10) на етапі обробки. ' +
    'Змінюється лише формулювання критеріїв — шкала 1-10 і структура фіксовані кодом.';
  return { text, kb: rubricMenu() };
}

// /rubric command + Menu → open as a new message.
async function openRubricMenu(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = await rubricScreen();
  await showScreen(ctx, text, kb);
}

function registerRubric(bot) {
  bot.callbackQuery('rubric:open', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = await rubricScreen();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery('rubric:view', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { rubric, isCustom } = await getScoreRubricInfo();
    // Plain text: the rubric contains •, «», digits and punctuation that would break Markdown.
    await sendLong(ctx.api, ctx.chat.id, `⭐ Поточна рубрика (${isCustom ? 'власна' : 'стандартна'}):\n\n${rubric}`);
    // Re-plant the menu at the bottom so it's in focus after the (long) rubric text.
    const { text, kb } = await rubricScreen();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery('rubric:edit', async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.awaiting = { type: 'rubric' };
    await ctx.reply(
      '✏️ Надішліть новий текст рубрики одним повідомленням — він одразу застосується до наступних дзвінків (оцінка на етапі обробки).\n\nЩоб скасувати — відкрийте /menu.'
    );
  });

  bot.callbackQuery('rubric:reset', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('✅ Так, скинути', 'rubric:resetok')
      .row()
      .text('« Назад', 'rubric:open');
    await showScreen(ctx, 'Скинути рубрику до стандартної? Ваш власний текст буде видалено.', kb);
  });

  bot.callbackQuery('rubric:resetok', async (ctx) => {
    await resetScoreRubric();
    await ctx.answerCallbackQuery({ text: 'Скинуто' });
    const { text, kb } = await rubricScreen();
    await showScreen(ctx, `↩️ Рубрику скинуто до стандартної.\n\n${text}`, kb);
  });
}

export { registerRubric, openRubricMenu };
