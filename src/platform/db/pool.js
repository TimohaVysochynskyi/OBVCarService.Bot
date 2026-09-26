import pg from 'pg';
import { config } from '../../shared/config.js';
import { runMigrations } from './runMigrations.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl,
});

let poolErrorHandler = null;
pool.on('error', (err) => {
  console.error(`[db] помилка простійного підключення до Postgres: ${err.message}`);
  if (!poolErrorHandler) return;
  try {
    poolErrorHandler(err);
  } catch (inner) {
    console.error(`[db] обробник помилки пулу впав: ${inner.message}`);
  }
});

function onPoolError(handler) {
  poolErrorHandler = handler;
}

async function migrate() {
  await runMigrations(pool);
}

async function pingDb() {
  await pool.query('SELECT 1');
  return true;
}

export {
  pool,
  onPoolError,
  migrate,
  pingDb,
};
