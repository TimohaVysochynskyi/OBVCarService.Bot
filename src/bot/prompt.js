import { InlineKeyboard } from 'grammy';
import { getAnalyzePromptInfo, setAnalyzePrompt, resetAnalyzePrompt } from './analyze.js';
import { getScoreRubricInfo, setScoreRubric, resetScoreRubric } from '../core/classifyCall.js';
import { sendLong, showScreen } from './ui.js';

// Single owner-facing hub for every editable AI instruction (/prompt, admin-only). There used to be
// one command and one near-identical module per instruction (/prompt for the report guidance,
// /rubric for the score rubric), which meant two menu entries and two copies of the same screens
// drifting apart in wording. Now: ONE command, ONE set of screens, and a registry of what can be
// edited. Adding the planned third instruction (script evaluation) is one entry in EDITABLE — the
// screens, callbacks and free-text handling come for free, so the UI cannot drift.
//
// Every entry only tunes WORDING. The structures that keep results trustworthy — the findings JSON
// schema and the >=3-evidence rule (analyze.js: assembleFindings), the 1-10 scale, and the stage
// taxonomy (core/stages.js) — are enforced by code and deliberately not editable here.

const EDITABLE = [
  {
    key: 'analysis',
    button: '🧠 Промпт аналізу ефективності',
    title: '🧠 *Промпт аналізу ефективності*',
    about:
      'Системна інструкція для AI, коли він оцінює роботу менеджера у звіті — і в авто-звітах, і в «Звіт зараз».',
    effect: 'Застосується до наступних аналізів і звітів.',
    info: async () => {
      const { prompt, isCustom } = await getAnalyzePromptInfo();
      return { value: prompt, isCustom };
    },
    save: setAnalyzePrompt,
    reset: resetAnalyzePrompt,
  },
  {
    key: 'score',
    button: '⭐️ Оцінка комунікації менеджера',
    title: '⭐️ *Оцінка комунікації менеджера*',
    about:
      'Критерії, за якими AI виставляє кожному дзвінку бал комунікації (1-10) на етапі обробки. ' +
      'Змінюється лише формулювання критеріїв — шкала 1-10 і структура фіксовані кодом.',
    effect: 'Застосується до наступних дзвінків (оцінка на етапі обробки).',
    info: async () => {
      const { rubric, isCustom } = await getScoreRubricInfo();
      return { value: rubric, isCustom };
    },
    save: setScoreRubric,
    reset: resetScoreRubric,
  },
];

const entryOf = (key) => EDITABLE.find((e) => e.key === key) || null;

// --- Hub: pick WHICH instruction to edit ----------------------------------------------------

function hubScreen() {
  const kb = new InlineKeyboard();
  for (const e of EDITABLE) kb.text(e.button, `prompt:o:${e.key}`).row();
  kb.text('« Назад до меню', 'menu');
  const text =
    '🧠 *Промпти AI*\n\n' +
    'Тут редагуються інструкції, за якими AI оцінює роботу менеджерів. Оберіть, що змінити:';
  return { text, kb };
}

// --- Detail: view / edit / reset ONE instruction ---------------------------------------------
// Wording is deliberately generic ("текст"), identical for every entry — that is what keeps the
// style uniform. Ukrainian gender agreement would otherwise force per-entry sentence variants
// («скинути промпт до стандартного» vs «скинути рубрику до стандартної»), which is exactly how the
// two screens drifted apart before.

async function detailScreen(key) {
  const e = entryOf(key);
  if (!e) return null;
  const { isCustom } = await e.info();
  const status = isCustom
    ? '✏️ Зараз використовується *власний* текст.'
    : '📄 Зараз використовується *стандартний* текст.';
  const kb = new InlineKeyboard()
    .text('👁 Переглянути поточний', `prompt:v:${key}`)
    .row()
    .text('✏️ Змінити', `prompt:e:${key}`)
    .row()
    .text('↩️ Скинути до стандартного', `prompt:r:${key}`)
    .row()
    .text('« Назад', 'prompt')
    .row()
    .text('« Назад до меню', 'menu');
  return { text: `${e.title}\n\n${status}\n\n${e.about}`, kb };
}

// /prompt command + Menu button → open the hub as a new message.
async function openPromptMenu(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = hubScreen();
  await showScreen(ctx, text, kb);
}

// Free-text step: the owner sent the new text for the instruction they were editing (routed from
// index.js by ctx.session.awaiting = { type: 'prompt', key }).
async function savePromptText(ctx, key, text) {
  const e = entryOf(key);
  ctx.session.awaiting = null;
  if (!e) {
    await ctx.reply('Не зрозуміло, який саме текст змінювався — відкрийте /prompt і спробуйте ще раз.');
    return;
  }
  await e.save(text);
  await ctx.reply(`✅ Оновлено. ${e.effect}`);
  const screen = await detailScreen(key);
  if (screen) await showScreen(ctx, screen.text, screen.kb);
}

function registerPrompt(bot) {
  bot.callbackQuery('prompt', async (ctx) => {
    ctx.session.awaiting = null;
    await ctx.answerCallbackQuery();
    const { text, kb } = hubScreen();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery(/^prompt:o:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const screen = await detailScreen(ctx.match[1]);
    if (!screen) return;
    await showScreen(ctx, screen.text, screen.kb);
  });

  bot.callbackQuery(/^prompt:v:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = ctx.match[1];
    const e = entryOf(key);
    if (!e) return;
    const { value, isCustom } = await e.info();
    // Plain text: these texts contain * _ • «» that would break Markdown parsing.
    await sendLong(ctx.api, ctx.chat.id, `Поточний текст (${isCustom ? 'власний' : 'стандартний'}):\n\n${value}`);
    // Re-plant the screen at the bottom so navigation stays in focus after the long text.
    const screen = await detailScreen(key);
    if (screen) await showScreen(ctx, screen.text, screen.kb);
  });

  bot.callbackQuery(/^prompt:e:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = ctx.match[1];
    const e = entryOf(key);
    if (!e) return;
    ctx.session.awaiting = { type: 'prompt', key };
    await ctx.reply(
      `✏️ Надішліть новий текст одним повідомленням. ${e.effect}\n\nЩоб скасувати — відкрийте /menu.`
    );
  });

  bot.callbackQuery(/^prompt:r:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = ctx.match[1];
    if (!entryOf(key)) return;
    const kb = new InlineKeyboard()
      .text('✅ Так, скинути', `prompt:rok:${key}`)
      .row()
      .text('« Назад', `prompt:o:${key}`);
    await showScreen(ctx, 'Скинути до стандартного тексту? Ваш власний текст буде видалено.', kb);
  });

  bot.callbackQuery(/^prompt:rok:(\w+)$/, async (ctx) => {
    const key = ctx.match[1];
    const e = entryOf(key);
    if (!e) return;
    await e.reset();
    await ctx.answerCallbackQuery({ text: 'Скинуто' });
    const screen = await detailScreen(key);
    if (screen) await showScreen(ctx, `↩️ Скинуто до стандартного тексту.\n\n${screen.text}`, screen.kb);
  });
}

export { registerPrompt, openPromptMenu, savePromptText, EDITABLE };
