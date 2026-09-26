import { pool } from '../../platform/db/pool.js';
import { deleteState, getState, setState } from '../../platform/db/state.js';

async function setHeartbeat(name, when = new Date()) {
  await setState(`heartbeat_${name}`, when.toISOString());
}

async function getHeartbeat(name) {
  const raw = await getState(`heartbeat_${name}`);
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

async function insertErrorLog(entry) {
  await pool.query(
    `INSERT INTO error_log (incident, code, process, feature, telegram_id, message, technical, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.incident,
      entry.code,
      entry.process,
      entry.feature ?? null,
      entry.telegramId ?? null,
      entry.message ?? null,
      entry.technical ?? null,
      entry.context ? JSON.stringify(entry.context) : null,
    ]
  );
}

function mapErrorRow(row) {
  return {
    id: row.id,
    incident: row.incident,
    code: row.code,
    at: row.at,
    process: row.process,
    feature: row.feature,
    telegramId: row.telegram_id,
    message: row.message,
    technical: row.technical,
    context: row.context,
  };
}

async function listErrorLog(limit = 10, { code = null } = {}) {
  const { rows } = code
    ? await pool.query('SELECT * FROM error_log WHERE code = $1 ORDER BY at DESC LIMIT $2', [code, limit])
    : await pool.query('SELECT * FROM error_log ORDER BY at DESC LIMIT $1', [limit]);
  return rows.map(mapErrorRow);
}

async function getErrorLogByIncident(incident) {
  const { rows } = await pool.query(
    'SELECT * FROM error_log WHERE incident = $1 ORDER BY at DESC LIMIT 1',
    [incident]
  );
  return rows[0] ? mapErrorRow(rows[0]) : null;
}

async function summarizeErrorLog(since) {
  const { rows } = await pool.query(
    `SELECT code, COUNT(*)::int AS "count", MAX(at) AS "lastAt"
       FROM error_log WHERE at >= $1
      GROUP BY code ORDER BY MAX(at) DESC`,
    [since]
  );
  return rows;
}

async function deleteOldErrorLog(before) {
  const { rowCount } = await pool.query('DELETE FROM error_log WHERE at < $1', [before]);
  return rowCount;
}

async function getRecipients(kind) {
  const raw = await getState(`${kind}_recipients`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function addRecipient(kind, { id, name }) {
  const list = await getRecipients(kind);
  const sid = String(id);
  if (list.some((r) => String(r.id) === sid)) return list;
  list.push({ id: sid, name: name || sid });
  await setState(`${kind}_recipients`, JSON.stringify(list));
  return list;
}

async function removeRecipient(kind, id) {
  const sid = String(id);
  const list = (await getRecipients(kind)).filter((r) => String(r.id) !== sid);
  await setState(`${kind}_recipients`, JSON.stringify(list));
  return list;
}

async function getAlertState(key) {
  const raw = await getState(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function setAlertState(key, state) {
  await setState(key, JSON.stringify(state));
}

async function clearAlertState(key) {
  await deleteState(key);
}

async function clearAlertStates(prefix) {
  const { rowCount } = await pool.query('DELETE FROM app_state WHERE key LIKE $1', [`${prefix}%`]);
  return rowCount;
}

export {
  setHeartbeat,
  getHeartbeat,
  insertErrorLog,
  listErrorLog,
  getErrorLogByIncident,
  summarizeErrorLog,
  deleteOldErrorLog,
  getRecipients,
  addRecipient,
  removeRecipient,
  getAlertState,
  setAlertState,
  clearAlertState,
  clearAlertStates,
};
