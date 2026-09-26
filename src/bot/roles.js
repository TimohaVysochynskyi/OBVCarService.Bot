import { InlineKeyboard, Keyboard } from 'grammy';
import {
  getBotUsersByRole,
  getBotUserById,
  upsertBotUserByTelegram,
  addPendingBotUser,
  setBotUserOperator,
  deleteBotUser,
  getOperators,
} from '../core/store.js';
import { ROLES, ROLE_LABELS, invalidateRole } from './access.js';
import { operatorLabels } from './keyboards.js';
import { displayName, formatPhone } from './operators.js';
import { showScreen } from './ui.js';

const MANAGEABLE_ROLES = [ROLES.MARKETER, ROLES.MANAGER, ROLES.MECHANIC];
const REQUEST_USERS_ID = 1;

function fullName(ctx) {
  return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null;
}

function memberLine(u) {
  const name = u.displayName || (u.username ? `@${u.username}` : null) || (u.phone ? formatPhone(u.phone) : `id${u.telegramId ?? '—'}`);
  const bits = [];
  if (u.username) bits.push(`@${u.username}`);
  if (u.phone) bits.push(formatPhone(u.phone));
  if (u.operatorName) bits.push(`оператор: ${displayName(u.operatorName)}`);
  if (u.status === 'pending') bits.push('⏳ очікує входу');
  return bits.length ? `${name} (${bits.join(', ')})` : name;
}


function rolesMenu() {
  const kb = new InlineKeyboard();
  for (const r of MANAGEABLE_ROLES) kb.text(`${ROLE_LABELS[r]}`, `roles:list:${r}`).row();
  kb.text('« Назад до меню', 'menu');
  return { text: '👥 *Ролі*\nОберіть роль, щоб переглянути / додати людей:', kb };
}

async function roleListScreen(role) {
  const users = await getBotUsersByRole(role);
  const kb = new InlineKeyboard();
  for (const u of users) {
    const label = u.displayName || (u.username ? `@${u.username}` : null) || (u.phone ? formatPhone(u.phone) : `id${u.telegramId}`);
    kb.text(`${u.status === 'pending' ? '⏳ ' : ''}${label}`, `roles:u:${u.id}`).row();
  }
  kb.text('➕ Додати', `roles:add:${role}`).row();
  kb.text('« Ролі', 'roles');
  const list = users.length
    ? users.map((u) => `• ${memberLine(u)}`).join('\n')
    : 'поки нікого немає.';
  return { text: `${ROLE_LABELS[role]} — люди на ролі:\n${list}`, kb };
}

async function memberScreen(id) {
  const u = await getBotUserById(id);
  if (!u) return null;
  const kb = new InlineKeyboard();
  if (u.role === ROLES.MANAGER) kb.text('🔗 Змінити оператора', `roles:oppick:${u.id}`).row();
  kb.text('🗑 Видалити', `roles:del:${u.id}`).row().text('« Назад', `roles:list:${u.role}`);
  const text =
    `${ROLE_LABELS[u.role]}\n${memberLine(u)}\n\n` +
    'Дії з людиною:';
  return { text, kb };
}

async function operatorPickScreen(memberId) {
  const operators = await getOperators();
  const kb = new InlineKeyboard();
  const labels = operatorLabels(operators);
  operators.forEach((o, i) => kb.text(labels[i], `roles:setop:${memberId}:${o.name}`).row());
  kb.text('« Пропустити', `roles:u:${memberId}`);
  return {
    text: 'Оберіть, ЯКИЙ оператор (за даними Binotel) — це ця людина, щоб вона бачила статистику по собі:',
    kb,
  };
}

function addKeyboard() {
  return new Keyboard()
    .requestUsers('👤 Обрати з контактів', REQUEST_USERS_ID, {
      user_is_bot: false,
      request_name: true,
      request_username: true,
      max_quantity: 1,
    })
    .row()
    .requestContact('📱 Поділитися контактом')
    .row()
    .text('✖️ Скасувати')
    .resized()
    .oneTime();
}


async function afterAdded(ctx, role, memberId, who) {
  await ctx.reply(`✅ Додано на роль «${ROLE_LABELS[role]}»: ${who}.`, { reply_markup: { remove_keyboard: true } });
  if (role === ROLES.MANAGER) {
    const { text, kb } = await operatorPickScreen(memberId);
    await showScreen(ctx, text, kb, { parseMode: null });
    return;
  }
  const { text, kb } = await roleListScreen(role);
  await showScreen(ctx, text, kb, { parseMode: null });
}

async function addByUsersShared(ctx, role) {
  const shared = ctx.message.users_shared;
  const users = shared?.users || [];
  if (!users.length) return;
  let lastId = null;
  let who = '';
  for (const su of users) {
    const name = [su.first_name, su.last_name].filter(Boolean).join(' ') || (su.username ? `@${su.username}` : `id${su.user_id}`);
    lastId = await upsertBotUserByTelegram({
      telegramId: su.user_id,
      role,
      username: su.username,
      displayName: name,
      addedBy: ctx.from.id,
    });
    invalidateRole(su.user_id);
    who = name;
  }
  ctx.session.awaiting = null;
  await afterAdded(ctx, role, lastId, who);
}

async function addByContact(ctx, role) {
  const c = ctx.message.contact;
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.phone_number ? formatPhone(c.phone_number) : 'контакт');
  ctx.session.awaiting = null;
  let memberId;
  if (c.user_id) {
    memberId = await upsertBotUserByTelegram({
      telegramId: c.user_id,
      role,
      phone: c.phone_number,
      displayName: name,
      addedBy: ctx.from.id,
    });
    invalidateRole(c.user_id);
  } else {
    memberId = await addPendingBotUser({ phone: c.phone_number, role, displayName: name, addedBy: ctx.from.id });
    await ctx.reply('ℹ️ Це контакт без Telegram-акаунта в спільних. Додав як запрошення — людина увійде, поділившись своїм номером боту.');
  }
  await afterAdded(ctx, role, memberId, name);
}

async function addByPhoneText(ctx, role) {
  const phone = ctx.message.text.replace(/\D/g, '');
  if (phone.length < 9) {
    await ctx.reply('Це не схоже на номер телефону. Надішліть номер (напр. 0674738200) або « Скасувати.');
    return;
  }
  ctx.session.awaiting = null;
  const memberId = await addPendingBotUser({ phone, role, addedBy: ctx.from.id });
  await ctx.reply('ℹ️ Додав як запрошення за номером. Людина увійде, коли відкриє бота й поділиться своїм контактом.', {
    reply_markup: { remove_keyboard: true },
  });
  await afterAdded(ctx, role, memberId, formatPhone(phone));
}


async function openRolesMenu(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = rolesMenu();
  await showScreen(ctx, text, kb);
}

function registerRoles(bot) {
  bot.callbackQuery('roles', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = rolesMenu();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery(/^roles:list:(director|marketer|manager|mechanic)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = await roleListScreen(ctx.match[1]);
    await showScreen(ctx, text, kb, { parseMode: null });
  });

  bot.callbackQuery(/^roles:u:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const screen = await memberScreen(Number(ctx.match[1]));
    if (!screen) {
      await ctx.reply('Запис не знайдено (можливо, вже видалено).');
      return;
    }
    await showScreen(ctx, screen.text, screen.kb, { parseMode: null });
  });

  bot.callbackQuery(/^roles:add:(marketer|manager|mechanic)$/, async (ctx) => {
    const role = ctx.match[1];
    await ctx.answerCallbackQuery();
    ctx.session.awaiting = { type: 'role_add', role };
    await ctx.reply(
      `➕ Додаємо людину на роль «${ROLE_LABELS[role]}».\n\n` +
        '• «Обрати з контактів» — вибрати колегу з ваших Telegram-контактів (найпростіше).\n' +
        '• «Поділитися контактом» — переслати картку контакту.\n' +
        '• Або просто напишіть номер телефону повідомленням.\n\n' +
        'Тег (@username) Telegram не дозволяє знаходити людей ботам — користуйтесь контактом або номером.',
      { reply_markup: addKeyboard() }
    );
  });

  bot.callbackQuery(/^roles:del:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await getBotUserById(Number(ctx.match[1]));
    if (!u) {
      await ctx.reply('Запис не знайдено.');
      return;
    }
    const kb = new InlineKeyboard()
      .text('✅ Так, видалити', `roles:delok:${u.id}`)
      .row()
      .text('« Ні, назад', `roles:u:${u.id}`);
    await showScreen(ctx, `Видалити ${memberLine(u)} з ролі «${ROLE_LABELS[u.role]}»?`, kb, { parseMode: null });
  });

  bot.callbackQuery(/^roles:delok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const u = await getBotUserById(id);
    const removed = await deleteBotUser(id);
    if (removed?.telegramId != null) invalidateRole(removed.telegramId);
    await ctx.answerCallbackQuery({ text: 'Видалено' });
    const role = u?.role || removed?.role;
    if (role) {
      const { text, kb } = await roleListScreen(role);
      await showScreen(ctx, text, kb, { parseMode: null });
    } else {
      const { text, kb } = rolesMenu();
      await showScreen(ctx, text, kb);
    }
  });

  bot.callbackQuery(/^roles:oppick:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = await operatorPickScreen(Number(ctx.match[1]));
    await showScreen(ctx, text, kb, { parseMode: null });
  });

  bot.callbackQuery(/^roles:setop:(\d+):(.+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const name = ctx.match[2];
    await setBotUserOperator(id, name);
    const u = await getBotUserById(id);
    if (u?.telegramId != null) invalidateRole(u.telegramId);
    await ctx.answerCallbackQuery({ text: 'Прив’язано' });
    const screen = await memberScreen(id);
    if (screen) await showScreen(ctx, screen.text, screen.kb, { parseMode: null });
  });

  bot.on('message:users_shared', async (ctx, next) => {
    const st = ctx.session.awaiting;
    if (st?.type !== 'role_add') {
      if (next) await next();
      return;
    }
    await addByUsersShared(ctx, st.role);
  });

  bot.on('message:contact', async (ctx, next) => {
    const st = ctx.session.awaiting;
    if (st?.type === 'role_add') {
      await addByContact(ctx, st.role);
      return;
    }
    if (next) await next();
  });
}

export { registerRoles, openRolesMenu, addByPhoneText, MANAGEABLE_ROLES };
