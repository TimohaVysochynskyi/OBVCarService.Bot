import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const LOCK_ID = 8683695884;

const REGISTRY = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

async function listMigrations(dir = MIGRATIONS_DIR) {
  const files = await readdir(dir);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function runMigrations(pool, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  await pool.query(REGISTRY);
  const files = await listMigrations(dir);
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const pending = files.filter((f) => !applied.has(f));
  if (!pending.length) return [];

  const client = await pool.connect();
  const done = [];
  try {
    for (const file of pending) {
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
        const check = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
        if (check.rowCount) {
          await client.query('ROLLBACK');
          continue;
        }
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        done.push(file);
        log(`[migrate] застосовано ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.migration = file;
        throw err;
      }
    }
  } finally {
    client.release();
  }
  return done;
}

export { runMigrations, listMigrations, MIGRATIONS_DIR };
