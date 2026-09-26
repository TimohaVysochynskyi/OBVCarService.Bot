import { getBotUser, seedDirector } from '../core/store.js';

const ROLES = {
  DIRECTOR: 'director',
  MARKETER: 'marketer',
  MANAGER: 'manager',
  MECHANIC: 'mechanic',
};

const ROLE_LABELS = {
  director: 'Директор',
  marketer: 'Маркетолог',
  manager: 'Менеджер',
  mechanic: 'Механік',
};

const ADMIN_ROLES = new Set([ROLES.DIRECTOR, ROLES.MARKETER]);

function isAdmin(role) {
  return ADMIN_ROLES.has(role);
}

function canAccess(role, feature) {
  if (!role) return false;
  if (isAdmin(role)) return true;
  if (role === ROLES.MANAGER) return ['menu', 'kb_ask', 'stats_self'].includes(feature);
  if (role === ROLES.MECHANIC) return ['menu', 'kb_ask'].includes(feature);
  return false;
}

function featureOf(ctx) {
  const cq = ctx.callbackQuery?.data;
  if (cq) {
    if (cq === 'menu' || cq === 'noop') return 'menu';
    if (cq.startsWith('err:')) return 'menu';
    if (cq === 'kb:ask') return 'kb_ask';
    if (cq.startsWith('kb:')) return 'kb_edit';
    if (cq.startsWith('stat:')) return 'stats_all';
    if (cq.startsWith('arch:')) return 'archive';
    if (cq.startsWith('report')) return 'report';
    if (cq.startsWith('prompt')) return 'prompt';
    if (cq.startsWith('roles')) return 'roles';
    if (cq === 'set' || cq.startsWith('set:')) return 'settings';
    if (cq === 'log' || cq.startsWith('log:')) return 'logs';
    if (cq === 'health' || cq.startsWith('health:')) return 'health';
    if (cq === 'greport') return 'global_report';
    if (cq.startsWith('me:')) return 'stats_self';
    return 'menu';
  }
  const text = ctx.message?.text;
  if (text && text.startsWith('/')) {
    const cmd = text.slice(1).split(/[\s@]/)[0];
    const map = {
      start: 'menu',
      menu: 'menu',
      stats: 'stats_all',
      archive: 'archive',
      ask: 'kb_ask',
      files: 'kb_edit',
      report: 'report',
      prompt: 'prompt',
      roles: 'roles',
      settings: 'settings',
      log: 'logs',
      health: 'health',
      globalreport: 'global_report',
      myreport: 'stats_self',
    };
    return map[cmd] ?? 'menu';
  }
  if (ctx.message?.document) return 'kb_edit';
  return null;
}

const roleCache = new Map();

async function getUser(telegramId) {
  if (telegramId == null) return null;
  const key = String(telegramId);
  if (roleCache.has(key)) return roleCache.get(key);
  const user = await getBotUser(telegramId);
  roleCache.set(key, user);
  return user;
}

function invalidateRole(telegramId) {
  if (telegramId == null) roleCache.clear();
  else roleCache.delete(String(telegramId));
}

async function seedDirectors() {
  const ids = new Set(
    (process.env.TELEGRAM_BOOTSTRAP_CHAT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s) && Number(s) > 0)
  );
  for (const id of ids) {
    await seedDirector(id);
    invalidateRole(id);
  }
  return ids.size;
}

export {
  ROLES,
  ROLE_LABELS,
  ADMIN_ROLES,
  isAdmin,
  canAccess,
  featureOf,
  getUser,
  invalidateRole,
  seedDirectors,
};
