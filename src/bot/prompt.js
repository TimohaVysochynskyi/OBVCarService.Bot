import { InlineKeyboard } from 'grammy';
import { getAnalyzePromptInfo, resetAnalyzePrompt } from './analyze.js';
import { sendLong, showScreen } from './ui.js';

// Owner-facing management of the analysis prompt (the system instruction used to evaluate
// operator work quality in reports). View / edit / reset; the effective prompt lives in
// app_state.analyze_prompt (analyze.js reads it, falling back to its built-in default).

function promptMenu() {
  return new InlineKeyboard()
    .text('👁 Переглянути поточний', 'prompt:view')
    .row()
    .text('✏️ Змінити', 'prompt:edit')
    .row()
    .text('↩️ Скинути до стандартного', 'prompt:reset')
    .row()
    .text('« Меню', 'menu');
}

// { text, kb } for the management screen — shared by the /prompt command (new message) and the
// callbacks that return to it (edit in place).
async function promptScreen() {
  const { isCustom } = await getAnalyzePromptInfo();
  const status = isCustom
    ? '✏️ Зараз використовується *власний* промпт.'
    : '📄 Зараз використовується *стандартний* промпт.';
  const text =
    '🧠 *Промпт аналізу ефективності*\n\n' +
    `${status}\n\n` +
    'Це системна інструкція для AI, коли він оцінює роботу менеджера у звіті — і в авто-звітах, і в «Звіт зараз».';
  return { text, kb: promptMenu() };
}

// /prompt command + Menu button → open as a new message.
async function openPromptMenu(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = await promptScreen();
  await showScreen(ctx, text, kb);
}

function registerPrompt(bot) {
  bot.callbackQuery('prompt:open', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = await promptScreen();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery('prompt:view', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { prompt, isCustom } = await getAnalyzePromptInfo();
    // Plain text: the prompt itself contains * and _ that would break Markdown parsing.
    await sendLong(ctx.api, ctx.chat.id, `🧠 Поточний промпт (${isCustom ? 'власний' : 'стандартний'}):\n\n${prompt}`);
    // Re-plant the menu at the bottom so it's in focus after the (long) prompt text.
    const { text, kb } = await promptScreen();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery('prompt:edit', async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.awaiting = { type: 'prompt' };
    await ctx.reply(
      '✏️ Надішліть новий текст промпту одним повідомленням — він одразу застосується до наступних аналізів і звітів.\n\nЩоб скасувати — відкрийте /menu.'
    );
  });

  bot.callbackQuery('prompt:reset', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('✅ Так, скинути', 'prompt:resetok')
      .row()
      .text('« Назад', 'prompt:open');
    await showScreen(ctx, 'Скинути промпт до стандартного? Ваш власний текст буде видалено.', kb);
  });

  bot.callbackQuery('prompt:resetok', async (ctx) => {
    await resetAnalyzePrompt();
    await ctx.answerCallbackQuery({ text: 'Скинуто' });
    const { text, kb } = await promptScreen();
    await showScreen(ctx, `↩️ Промпт скинуто до стандартного.\n\n${text}`, kb);
  });
}

export { registerPrompt, openPromptMenu };
