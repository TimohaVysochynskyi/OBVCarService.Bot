import { pool } from './pool.js';

async function getState(key) {
  const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function setState(key, value) {
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
}

async function deleteState(key) {
  await pool.query('DELETE FROM app_state WHERE key = $1', [key]);
}

export {
  getState,
  setState,
  deleteState,
};
