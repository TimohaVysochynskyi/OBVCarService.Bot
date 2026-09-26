import { InlineKeyboard } from 'grammy';
import {
  listPrompts,
  promptsInGroup,
  groupsOf,
  entryOf,
  promptInfo,
  savePrompt,
  resetPrompt,
  jobOf,
} from './promptRegistry.js';
import { run, estimate, stop, isRunning, blockCount, BLOCK, invalidateReportCache } from './reprocess.js';
import { sendLong, showScreen } from './ui.js';


const MENU = '« Назад до меню';


const money = (usd) => (usd < 0.01 ? 'менше цента' : `~$${usd.toFixed(2)}`);
const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const calls = (n) => `${n} ${plural(n, 'дзвінок', 'дзвінки', 'дзвінків')}`;

const parseScope = (raw) => (raw === 'all' ? { kind: 'all' } : { kind: 'block', block: Number(raw.slice(1)) });
const scopeLabel = (scope) =>
  scope.kind === 'all' ? 'усі дзвінки' : `блок ${scope.block} (${(scope.block - 1) * BLOCK + 1}-${scope.block * BLOCK})`;


function hubScreen() {
  const kb = new InlineKeyboard();
  for (const g of groupsOf()) kb.text(g.title, `prompt:g:${g.key}`).row();
  kb.text(MENU, 'menu');
  return {
    text:
      '🧠 *Промпти AI*\n\n' +
      `Тут редагуються всі ${listPrompts().length} інструкцій, за якими AI розбирає дзвінки й пише звіт.\n\n` +
      'Оберіть розділ:',
    kb,
  };
}


function groupScreen(group) {
  const items = promptsInGroup(group);
  if (!items.length) return null;
  const kb = new InlineKeyboard();
  for (const e of items) kb.text(e.button, `prompt:o:${e.key}`).row();
  kb.text('« Назад', 'prompt').row().text(MENU, 'menu');
  const title = groupsOf().find((g) => g.key === group)?.title || 'Промпти';
  return { text: `${title}\n\nОберіть інструкцію:`, kb };
}


async function detailScreen(key) {
  const e = await promptInfo(key);
  if (!e) return null;
  const job = jobOf(key);
  const status = e.isCustom
    ? '✏️ Зараз використовується *власний* текст.'
    : '📄 Зараз використовується *стандартний* текст.';

  const kb = new InlineKeyboard().text('👁 Переглянути поточний', `prompt:v:${key}`).row().text('✏️ Змінити', `prompt:e:${key}`).row();
  if (job) kb.text('♻️ Застосувати до наявних дзвінків', `prompt:a:${key}`).row();
  else kb.text('🗑 Скинути збережені висновки звіту', `prompt:cache:${key}`).row();
  kb.text('↩️ Скинути до стандартного', `prompt:r:${key}`).row().text('« Назад', `prompt:g:${e.group}`).row().text(MENU, 'menu');

  const applies = job
    ? `\n\n♻️ Цей текст визначає: ${job.what}.\nЗміна діє на НОВІ дзвінки одразу; щоб вона торкнулась уже оброблених — треба перерахунок.`
    : '\n\n♻️ Цей текст застосовується при побудові звіту, окремо перераховувати дзвінки не треба.';

  return { text: `${e.title}\n\n${status}\n\n${e.about}${applies}`, kb };
}


async function openPromptMenu(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = hubScreen();
  await showScreen(ctx, text, kb);
}

async function savePromptText(ctx, key, text) {
  ctx.session.awaiting = null;
  const e = entryOf(key);
  if (!e) {
    await ctx.reply('Не зрозуміло, який саме текст змінювався — відкрийте /prompt і спробуйте ще раз.');
    return;
  }
  const clean = String(text || '').trim();
  if (clean.length < 20) {
    await ctx.reply('Текст замалий — схоже на випадкове повідомлення. Надішліть повну інструкцію або відкрийте /menu.');
    return;
  }

  ctx.session.pendingPrompt = { key, text: clean };
  const preview = clean.length > 600 ? `${clean.slice(0, 600)}…` : clean;
  const kb = new InlineKeyboard().text('✅ Так, зберегти', `prompt:sv:${key}`).row().text('✖️ Скасувати', `prompt:o:${key}`);
  await ctx.reply(`Новий текст для «${e.button}» (${clean.length} символів):\n\n${preview}`);
  await showScreen(ctx, '❓ Дійсно замінити цю інструкцію?', kb);
}


async function applyScreen(key) {
  const e = entryOf(key);
  const job = jobOf(key);
  if (!e || !job) return null;
  const blocks = await blockCount();
  const kb = new InlineKeyboard()
    .text('✅ Лише для нових дзвінків', `prompt:o:${key}`)
    .row()
    .text('♻️ Перезаписати всі', `prompt:ac:${key}:all`)
    .row()
    .text(`🎯 Застосувати вибірково (по ${BLOCK})`, `prompt:blk:${key}`)
    .row()
    .text('« Назад', `prompt:o:${key}`);
  return {
    text:
      `♻️ *Застосування: ${job.title}*\n\n` +
      `Буде перераховано: ${job.what}.\n` +
      (job.warn ? `\n⚠️ ${job.warn}\n` : '') +
      `\nІсторія поділена на *${blocks}* ${plural(blocks, 'блок', 'блоки', 'блоків')} по ${BLOCK} дзвінків, ` +
      'блок 1 — найновіші.\n\nЩо зробити?',
    kb,
  };
}

async function blockScreen(key) {
  const blocks = await blockCount();
  const kb = new InlineKeyboard();
  for (let i = 1; i <= blocks; i += 1) {
    kb.text(`${i} · ${(i - 1) * BLOCK + 1}-${i * BLOCK}`, `prompt:ac:${key}:b${i}`);
    if (i % 2 === 0) kb.row();
  }
  kb.row().text('« Назад', `prompt:a:${key}`);
  return { text: '🎯 *Оберіть блок*\n\nБлок 1 — найновіші дзвінки, далі вглиб історії.', kb };
}

async function confirmScreen(key, scopeRaw) {
  const job = jobOf(key);
  if (!job) return null;
  const scope = parseScope(scopeRaw);
  const est = await estimate(entryOf(key).job, scope);

  const kb = new InlineKeyboard()
    .text('▶️ Запустити', `prompt:go:${key}:${scopeRaw}`)
    .row()
    .text('✖️ Скасувати', `prompt:a:${key}`);
  return {
    text:
      `❓ *Підтвердьте перерахунок*\n\n` +
      `Що: ${job.title} — ${job.what}\n` +
      `Обсяг: ${scopeLabel(scope)}\n` +
      `Підходить під цей перерахунок: *${calls(est.applicable)}* із ${est.inScope}\n` +
      `Модель: ${est.model}\n` +
      `Орієнтовна вартість: *${money(est.usd)}*\n` +
      `Орієнтовний час: ~${est.minutes} хв\n` +
      (job.warn ? `\n⚠️ ${job.warn}\n` : '') +
      '\nПерерахунок можна зупинити будь-коли.',
    kb,
  };
}


const PROGRESS_MS = 5000;

async function startRun(ctx, key, scopeRaw) {
  const e = entryOf(key);
  const job = jobOf(key);
  if (!e || !job) return;
  if (isRunning()) {
    await showScreen(ctx, '⏳ Один перерахунок уже виконується. Дочекайтесь його завершення.', new InlineKeyboard().text(MENU, 'menu'));
    return;
  }

  const scope = parseScope(scopeRaw);
  const stopKb = new InlineKeyboard().text('⛔️ Зупинити', 'prompt:stop');
  const msg = await ctx.api.sendMessage(ctx.chat.id, `▶️ ${job.title}: запускаю…`, { reply_markup: stopKb });

  let lastEdit = 0;
  const onProgress = async (s) => {
    if (Date.now() - lastEdit < PROGRESS_MS) return;
    lastEdit = Date.now();
    const pct = s.total ? Math.round(((s.done + s.skipped + s.failed) / s.total) * 100) : 0;
    await ctx.api
      .editMessageText(ctx.chat.id, msg.message_id, `▶️ ${job.title}\n\nОброблено: ${s.done} · пропущено: ${s.skipped}${s.failed ? ` · помилок: ${s.failed}` : ''}\nПройдено ${pct}% обсягу`, {
        reply_markup: stopKb,
      })
      .catch(() => {});
  };

  let result;
  try {
    result = await run({ job: e.job, scope, onProgress });
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, `⚠️ Перерахунок зупинився: ${err.message}`).catch(() => {});
    return;
  }

  await invalidateReportCache().catch(() => {});

  const took = Math.max(1, Math.round((Date.now() - result.startedAt) / 60000));
  const kb = new InlineKeyboard().text('📊 Перезібрати звіт зараз', 'prompt:rep').row().text('Пізніше', `prompt:o:${key}`);
  await ctx.api
    .editMessageText(
      ctx.chat.id,
      msg.message_id,
      `${result.stopped ? '⛔️ Зупинено' : '✅ Готово'} — ${job.title}\n\n` +
        `Перераховано: ${result.done}\n` +
        `Пропущено (не підходили): ${result.skipped}\n` +
        (result.failed ? `Не вдалося: ${result.failed}\n` : '') +
        `Часу: ~${took} хв`
    )
    .catch(() => {});
  await showScreen(
    ctx,
    'Збережені висновки звіту очищені — вони спирались на старий розбір.\n\n' +
      '📊 Перезібрати звіт зараз? Це окрема, платна дія (кілька центів, якщо змін небагато).',
    kb
  );
}


function registerPrompt(bot) {
  const screen = async (ctx, built) => {
    if (built) await showScreen(ctx, built.text, built.kb);
  };

  bot.callbackQuery('prompt', async (ctx) => {
    ctx.session.awaiting = null;
    await ctx.answerCallbackQuery();
    await screen(ctx, hubScreen());
  });

  bot.callbackQuery(/^prompt:g:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await screen(ctx, groupScreen(ctx.match[1]));
  });

  bot.callbackQuery(/^prompt:o:(\w+)$/, async (ctx) => {
    ctx.session.pendingPrompt = null;
    await ctx.answerCallbackQuery();
    await screen(ctx, await detailScreen(ctx.match[1]));
  });

  bot.callbackQuery(/^prompt:v:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = ctx.match[1];
    const e = await promptInfo(key);
    if (!e) return;
    await sendLong(ctx.api, ctx.chat.id, `Поточний текст (${e.isCustom ? 'власний' : 'стандартний'}):\n\n${e.value}`);
    await screen(ctx, await detailScreen(key));
  });

  bot.callbackQuery(/^prompt:e:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = ctx.match[1];
    const e = entryOf(key);
    if (!e) return;
    ctx.session.awaiting = { type: 'prompt', key };
    await ctx.reply(
      `✏️ Надішліть новий текст для «${e.button}» одним повідомленням.\n\n` +
        'Перед збереженням буде підтвердження. Щоб скасувати — відкрийте /menu.'
    );
  });

  bot.callbackQuery(/^prompt:sv:(\w+)$/, async (ctx) => {
    const key = ctx.match[1];
    const pending = ctx.session.pendingPrompt;
    if (!pending || pending.key !== key) {
      await ctx.answerCallbackQuery({ text: 'Текст загубився — надішліть ще раз' });
      await screen(ctx, await detailScreen(key));
      return;
    }
    await savePrompt(key, pending.text);
    ctx.session.pendingPrompt = null;
    await ctx.answerCallbackQuery({ text: 'Збережено' });
    const apply = await applyScreen(key);
    if (apply) await showScreen(ctx, `✅ Збережено.\n\n${apply.text}`, apply.kb);
    else await screen(ctx, await detailScreen(key));
  });

  bot.callbackQuery(/^prompt:r:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = ctx.match[1];
    if (!entryOf(key)) return;
    const kb = new InlineKeyboard().text('✅ Так, скинути', `prompt:rok:${key}`).row().text('« Назад', `prompt:o:${key}`);
    await showScreen(ctx, '❓ Скинути до стандартного тексту? Ваш власний текст буде видалено.', kb);
  });

  bot.callbackQuery(/^prompt:rok:(\w+)$/, async (ctx) => {
    const key = ctx.match[1];
    if (!entryOf(key)) return;
    await resetPrompt(key);
    await ctx.answerCallbackQuery({ text: 'Скинуто' });
    const apply = await applyScreen(key);
    if (apply) await showScreen(ctx, `↩️ Скинуто до стандартного тексту.\n\n${apply.text}`, apply.kb);
    else await screen(ctx, await detailScreen(key));
  });

  bot.callbackQuery(/^prompt:a:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await screen(ctx, await applyScreen(ctx.match[1]));
  });

  bot.callbackQuery(/^prompt:blk:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await screen(ctx, await blockScreen(ctx.match[1]));
  });

  bot.callbackQuery(/^prompt:ac:(\w+):(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await screen(ctx, await confirmScreen(ctx.match[1], ctx.match[2]));
  });

  bot.callbackQuery(/^prompt:go:(\w+):(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await startRun(ctx, ctx.match[1], ctx.match[2]);
  });

  bot.callbackQuery('prompt:stop', async (ctx) => {
    stop();
    await ctx.answerCallbackQuery({ text: 'Зупиняю після поточного дзвінка' });
  });

  bot.callbackQuery(/^prompt:cache:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await invalidateReportCache().catch(() => {});
    const kb = new InlineKeyboard().text('📊 Перезібрати звіт зараз', 'prompt:rep').row().text('Пізніше', `prompt:o:${ctx.match[1]}`);
    await showScreen(
      ctx,
      '🗑 Збережені висновки звіту очищені — наступна збірка порахує їх за новим текстом.\n\n' +
        '⚠️ Саме перезбирання платне: воно заново проаналізує всі дні історії.',
      kb
    );
  });

  bot.callbackQuery('prompt:rep', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { sendGlobalReport } = await import('./globalReport.js');
    await sendGlobalReport(ctx);
  });
}

export { registerPrompt, openPromptMenu, savePromptText };
