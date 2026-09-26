import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readRepo, readSrc } from '../helpers/repo.js';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../../src/platform/db/runMigrations.js';

const files = await listMigrations();
const sqlOf = (name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
const ALL_SQL = files.map(sqlOf).join('\n');

const fixture = readRepo('test/fixtures/prod-schema.txt').split('\n').filter(Boolean);
const rowsOf = (kind) => fixture.filter((l) => l.startsWith(`${kind}|`)).map((l) => l.split('|'));
const KB_TABLES = ['kb_docs', 'kb_chunks'];

function fakePool() {
  const log = [];
  const client = {
    query: async (sql, params) => {
      log.push({ sql: String(sql).trim().split('\n')[0].slice(0, 60), params });
      if (/SELECT 1 FROM schema_migrations/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release: () => log.push({ sql: 'RELEASE' }),
  };
  return {
    log,
    query: async (sql) => {
      log.push({ sql: String(sql).trim().split('\n')[0].slice(0, 60) });
      if (/SELECT name FROM schema_migrations/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    connect: async () => client,
  };
}

test('міграції лежать окремими пронумерованими файлами', () => {
  assert.ok(files.length >= 9, `файлів лише ${files.length}`);
  for (const name of files) assert.match(name, /^\d{4}_[a-z_]+\.sql$/, `дивна назва: ${name}`);
});

test('номери унікальні, і сортування за назвою дає порядок застосування', () => {
  const numbers = files.map((f) => f.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, 'два файли з одним номером');
  assert.deepEqual(files, [...files].sort());
});

test('кожна колонка робочої бази створюється якоюсь міграцією', () => {
  const missing = [];
  for (const [, table, column] of rowsOf('COLUMN')) {
    if (KB_TABLES.includes(table)) continue;
    if (column === 'id') continue;
    const created = new RegExp(`(ADD COLUMN IF NOT EXISTS ${column}\\b)|(^\\s*${column} )`, 'm').test(ALL_SQL);
    if (!created) missing.push(`${table}.${column}`);
  }
  assert.deepEqual(missing, [], `колонки без міграції: ${missing.join(', ')}`);
});

test('кожна таблиця робочої бази створюється якоюсь міграцією', () => {
  const tables = [...new Set(rowsOf('COLUMN').map((r) => r[1]))].filter((t) => !KB_TABLES.includes(t));
  for (const table of tables) {
    assert.match(ALL_SQL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), `немає CREATE для ${table}`);
  }
});

test('кожен неавтоматичний індекс робочої бази створюється міграцією', () => {
  const created = rowsOf('INDEX')
    .filter(([, table]) => !KB_TABLES.includes(table))
    .filter(([, , name]) => !name.endsWith('_pkey') && !name.endsWith('_key'));
  for (const [, , name] of created) {
    assert.match(ALL_SQL, new RegExp(`CREATE (UNIQUE )?INDEX IF NOT EXISTS ${name}\\b`), `немає індексу ${name}`);
  }
});

test('таблиці бази знань навмисно поза цими міграціями', () => {
  for (const table of KB_TABLES) {
    assert.ok(!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`).test(ALL_SQL), `${table} потрапила у звичайні міграції`);
  }
  assert.match(readSrc('core/store.js'), /async function migrateKb\(\)/);
  assert.match(readSrc('core/store.js'), /CREATE EXTENSION IF NOT EXISTS vector/);
});

test('легасі-прибирання пережили переїзд', () => {
  for (const statement of [
    'DROP TABLE IF EXISTS manager_notes;',
    'DROP TABLE IF EXISTS managers;',
    'ALTER TABLE calls DROP COLUMN IF EXISTS manager_id;',
    'ALTER TABLE calls DROP COLUMN IF EXISTS call_type;',
    'ALTER TABLE pending_calls DROP COLUMN IF EXISTS call_type;',
  ]) {
    assert.ok(ALL_SQL.includes(statement), `загублено: ${statement}`);
  }
});

test('виправлення історичного етапу й guard промпту теж на місці', () => {
  assert.match(ALL_SQL, /UPDATE calls SET weakest_stage = 'закриття угоди' WHERE weakest_stage = 'закриття';/);
  assert.match(ALL_SQL, /DELETE FROM app_state WHERE key = 'analyze_prompt'/);
  assert.match(ALL_SQL, /INSERT INTO app_state \(key, value\) VALUES \('analyze_prompt_v2', '1'\)/);
});

test('direction додається ПІСЛЯ дропу call_type — інакше колонку зітре', () => {
  const dropFile = files.find((f) => sqlOf(f).includes('DROP COLUMN IF EXISTS call_type'));
  const addFile = files.find((f) => sqlOf(f).includes('ADD COLUMN IF NOT EXISTS direction'));
  assert.ok(dropFile && addFile);
  assert.ok(files.indexOf(dropFile) <= files.indexOf(addFile), `${addFile} застосується раніше за ${dropFile}`);
  if (dropFile === addFile) {
    const sql = sqlOf(dropFile);
    assert.ok(sql.indexOf('DROP COLUMN IF EXISTS call_type') < sql.indexOf('ADD COLUMN IF NOT EXISTS direction'));
  }
});

test('кожна міграція ідемпотентна — її можна накотити на вже живу базу', () => {
  const unsafe = [];
  for (const name of files) {
    for (const line of sqlOf(name).split('\n')) {
      const statement = line.trim();
      if (/^CREATE TABLE /.test(statement) && !/IF NOT EXISTS/.test(statement)) unsafe.push(`${name}: ${statement}`);
      if (/^CREATE( UNIQUE)? INDEX /.test(statement) && !/IF NOT EXISTS/.test(statement)) unsafe.push(`${name}: ${statement}`);
      if (/^ALTER TABLE .* ADD COLUMN /.test(statement) && !/IF NOT EXISTS/.test(statement)) unsafe.push(`${name}: ${statement}`);
      if (/^DROP TABLE /.test(statement) && !/IF EXISTS/.test(statement)) unsafe.push(`${name}: ${statement}`);
    }
  }
  assert.deepEqual(unsafe, [], `неідемпотентні команди: ${unsafe.join(' | ')}`);
});

test('store.js більше не тримає схему — лише кличе раннер', () => {
  const store = readSrc('core/store.js');
  assert.match(store, /async function migrate\(\) \{\s*\n\s*await runMigrations\(pool\);\s*\n\}/);
  assert.ok(!/CREATE TABLE IF NOT EXISTS calls \(/.test(store), 'схема лишилась у store.js');
});

test('раннер створює реєстр, застосовує все нове і записує назви', async () => {
  const pool = fakePool();
  const applied = await runMigrations(pool, { log: () => {} });
  assert.deepEqual(applied, files);
  const sqls = pool.log.map((e) => e.sql);
  assert.ok(sqls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS schema_migrations')));
  const inserts = pool.log.filter((e) => e.sql.startsWith('INSERT INTO schema_migrations'));
  assert.deepEqual(inserts.map((e) => e.params[0]), files);
});

test('кожен файл їде у власній транзакції під блокуванням', async () => {
  const pool = fakePool();
  await runMigrations(pool, { log: () => {} });
  const sqls = pool.log.map((e) => e.sql);
  assert.equal(sqls.filter((s) => s === 'BEGIN').length, files.length);
  assert.equal(sqls.filter((s) => s === 'COMMIT').length, files.length);
  assert.equal(sqls.filter((s) => s.includes('pg_advisory_xact_lock')).length, files.length);
  assert.ok(sqls.indexOf('BEGIN') < sqls.indexOf('COMMIT'));
});

test('уже застосовані міграції не виконуються вдруге', async () => {
  const pool = fakePool();
  pool.query = async (sql) => {
    if (/SELECT name FROM schema_migrations/.test(sql)) return { rows: files.map((name) => ({ name })) };
    return { rows: [] };
  };
  let connected = false;
  pool.connect = async () => { connected = true; throw new Error('не мав брати зʼєднання'); };
  const applied = await runMigrations(pool, { log: () => {} });
  assert.deepEqual(applied, []);
  assert.equal(connected, false);
});

test('збій міграції відкочує транзакцію і називає файл', async () => {
  const pool = fakePool();
  const client = await pool.connect();
  const original = client.query;
  client.query = async (sql, params) => {
    if (String(sql).includes('CREATE TABLE IF NOT EXISTS calls')) throw new Error('boom');
    return original(sql, params);
  };
  pool.connect = async () => client;
  await assert.rejects(() => runMigrations(pool, { log: () => {} }), (err) => {
    assert.equal(err.migration, files[0]);
    return true;
  });
  assert.ok(pool.log.some((e) => e.sql === 'ROLLBACK'));
});

test('еталон схеми лежить у репозиторії і не містить даних клієнтів', () => {
  const raw = readRepo('test/fixtures/prod-schema.txt');
  assert.ok(raw.includes('COLUMN|calls|general_call_id'));
  assert.ok(!/\+?380\d{7}/.test(raw), 'у еталон схеми протік телефон');
  assert.ok(!fs.existsSync(path.join(ROOT, 'test/fixtures/prod-data.txt')));
});
