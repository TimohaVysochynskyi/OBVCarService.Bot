import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, migrationsSql } from '../../helpers/repo.js';

const schema = migrationsSql();
const reprocess = readSrc('features/analysis/reprocess.js');
const repo = readSrc('features/analysis/repo.js');
const ui = readSrc('features/prompts/ui.js');
const boot = readSrc('apps/bot/index.js');

test('таблиця jobs створюється міграцією і тримає позицію прогону', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS jobs \(/);
  for (const column of ['kind', 'status', 'params', 'cursor', 'total', 'done', 'skipped', 'failed',
    'error', 'chat_id', 'message_id']) {
    assert.match(schema, new RegExp(`\\n\\s+${column} `), `у jobs немає колонки ${column}`);
  }
});

test('«один перерахунок водночас» тримає БАЗА, а не прапорець у памʼяті', () => {
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS jobs_single_running ON jobs \(status\) WHERE status = 'running';/);
  assert.ok(!/let current = null/.test(reprocess), 'лишився памʼятний прапорець, який не переживе рестарт');
});

test('позиція зберігається в базі після КОЖНОГО дзвінка', () => {
  assert.match(reprocess, /const PROGRESS_EVERY = 1;/);
  assert.match(reprocess, /await saveJobProgress\(row\.id, state\)/);
  assert.match(repo, /UPDATE jobs SET cursor = \$2, done = \$3, skipped = \$4, failed = \$5/);
});

test('прогін продовжується саме з позиції, а не з початку блоку', () => {
  const fn = reprocess.match(/async function runJob[\s\S]*?\n\}/)[0];
  assert.match(fn, /cursor: row\.cursor/);
  assert.match(fn, /offset \+ state\.cursor/);
  assert.ok(!/offset \+ seen/.test(fn), 'лишилась стара локальна позиція');
});

test('після перезапуску бот сам підхоплює незавершений прогін', () => {
  assert.match(reprocess, /async function resumeJob/);
  assert.match(boot, /resumeInterruptedRun\(bot\.api\)/);
  assert.ok(boot.indexOf('resumeInterruptedRun') < boot.indexOf('await bot.start'),
    'продовження мусить початись до того, як бот почне приймати апдейти');
});

test('продовжений прогін редагує ТЕ САМЕ повідомлення, а не лишає мертве', () => {
  assert.match(repo, /chat_id AS "chatId", message_id AS "messageId"/);
  assert.match(ui, /progressReporter\(api, row\.chatId, row\.messageId/);
});

test('зупинка пишеться в базу, тож переживає рестарт', () => {
  assert.match(reprocess, /async function stop\(\)[\s\S]*?cancelRunningJob\(\)/);
  assert.match(repo, /UPDATE jobs SET status = 'cancelled'/);
  assert.match(ui, /await stop\(\);/);
});

test('воркер помічає скасування, навіть якщо його натиснули в іншому процесі', () => {
  const fn = reprocess.match(/async function runJob[\s\S]*?\n\}/)[0];
  assert.match(fn, /const alive = await saveJobProgress\(row\.id, state\);/);
  assert.match(fn, /if \(!alive\)/);
  assert.match(repo, /WHERE id = \$1 AND status = 'running'/);
});

test('завершення прогону фіксується статусом, а не мовчазним виходом', () => {
  const fn = reprocess.match(/async function runJob[\s\S]*?\n\}/)[0];
  assert.match(fn, /finishJob\(row\.id, \{ status: state\.stopped \? 'cancelled' : 'done' \}\)/);
  assert.match(fn, /finishJob\(row\.id, \{ status: 'failed', error: err\.message \}\)/);
});

test('спроба запустити другий перерахунок дає зрозумілий текст, а не помилку Postgres', () => {
  assert.match(reprocess, /jobs_single_running/);
  assert.match(reprocess, /Один перерахунок уже виконується/);
});

test('стан прогонів видно в журналі', () => {
  const incidents = readSrc('features/ops/incidents.js');
  assert.match(incidents, /getRecentJobs\(3\)/);
  assert.match(incidents, /LOG\.jobRow\(/);
  assert.match(readSrc('shared/errorTexts.js'), /jobRow: \(kind, status, done, pct, at\)/);
});

test('журнал не падає, якщо таблиці jobs ще немає', () => {
  assert.match(readSrc('features/ops/incidents.js'), /getRecentJobs\(3\)\.catch\(\(\) => \[\]\)/);
});

test('темп перерахунку тримає черга лімітів, а ручна пауза лишилась гальмом', () => {
  assert.match(reprocess, /PAUSE_MS = \{ blocker: 0 \}/);
  assert.match(reprocess, /const pause = PAUSE_MS\[row\.kind\] \?\? DEFAULT_PAUSE_MS/);
  assert.match(readSrc('platform/openai/client.js'), /TPM_BY_MODEL = \{ 'gpt-4o': DEFAULT_TPM \}/);
});
