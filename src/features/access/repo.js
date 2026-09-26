import { pool } from '../../platform/db/pool.js';

const BOT_USER_COLS = `id, telegram_id AS "telegramId", role, phone, username,
  display_name AS "displayName", operator_name AS "operatorName", status`;

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

async function getBotUser(telegramId) {
  const { rows } = await pool.query(
    `SELECT ${BOT_USER_COLS} FROM bot_users WHERE telegram_id = $1`,
    [telegramId]
  );
  return rows[0] || null;
}

async function getBotUserById(id) {
  const { rows } = await pool.query(`SELECT ${BOT_USER_COLS} FROM bot_users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getBotUsersByRole(role) {
  const { rows } = await pool.query(
    `SELECT ${BOT_USER_COLS} FROM bot_users WHERE role = $1 ORDER BY status, display_name NULLS LAST, id`,
    [role]
  );
  return rows;
}

async function upsertBotUserByTelegram({ telegramId, role, phone, username, displayName, operatorName, addedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO bot_users (telegram_id, role, phone, username, display_name, operator_name, status, added_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
     ON CONFLICT (telegram_id) DO UPDATE SET
       role = $2,
       phone = COALESCE($3, bot_users.phone),
       username = COALESCE($4, bot_users.username),
       display_name = COALESCE($5, bot_users.display_name),
       operator_name = COALESCE($6, bot_users.operator_name),
       status = 'active'
     RETURNING id`,
    [telegramId, role, phone ? normalizePhone(phone) : null, username || null, displayName || null, operatorName || null, addedBy || null]
  );
  return rows[0].id;
}

async function addPendingBotUser({ phone, role, displayName, addedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO bot_users (telegram_id, role, phone, display_name, status, added_by)
     VALUES (NULL, $2, $1, $3, 'pending', $4) RETURNING id`,
    [normalizePhone(phone), role, displayName || null, addedBy || null]
  );
  return rows[0].id;
}

async function activatePendingByPhone(phone, { telegramId, username, displayName }) {
  const { rows } = await pool.query(
    `UPDATE bot_users SET telegram_id = $2, username = COALESCE($3, username),
       display_name = COALESCE($4, display_name), status = 'active'
     WHERE status = 'pending' AND telegram_id IS NULL
       AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 9) = RIGHT($1, 9)
     RETURNING id, role`,
    [normalizePhone(phone), telegramId, username || null, displayName || null]
  );
  return rows[0] || null;
}

async function setBotUserOperator(id, operatorName) {
  await pool.query('UPDATE bot_users SET operator_name = $2 WHERE id = $1', [id, operatorName]);
}

async function setBotUserPhone(telegramId, phone) {
  await pool.query('UPDATE bot_users SET phone = $2 WHERE telegram_id = $1', [telegramId, normalizePhone(phone)]);
}

async function deleteBotUser(id) {
  const { rows } = await pool.query('DELETE FROM bot_users WHERE id = $1 RETURNING telegram_id AS "telegramId", role', [id]);
  return rows[0] || null;
}

async function seedDirector(telegramId) {
  await pool.query(
    `INSERT INTO bot_users (telegram_id, role, display_name, status)
     VALUES ($1, 'director', 'Директор', 'active')
     ON CONFLICT (telegram_id) DO NOTHING`,
    [telegramId]
  );
}

export {
  normalizePhone,
  getBotUser,
  getBotUserById,
  getBotUsersByRole,
  upsertBotUserByTelegram,
  addPendingBotUser,
  activatePendingByPhone,
  setBotUserOperator,
  setBotUserPhone,
  deleteBotUser,
  seedDirector,
};
