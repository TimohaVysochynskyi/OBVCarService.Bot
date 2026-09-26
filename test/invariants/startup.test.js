import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from '../helpers/repo.js';

const run = promisify(execFile);

const BLANK = {
  DATABASE_URL: '', TELEGRAM_BOT_TOKEN: '', BINOTEL_API_KEY: '', BINOTEL_API_SECRET: '', OPENAI_API_KEY: '',
};

async function start(entry) {
  try {
    const { stdout, stderr } = await run(process.execPath, [entry], {
      cwd: ROOT,
      env: { ...process.env, ...BLANK },
      timeout: 20000,
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

const bot = await start('src/bot/index.js');
const poll = await start('src/jobs/index.js');

test('бот із порожнім конфігом не стартує', () => {
  assert.equal(bot.code, 1);
});

test('...і пояснює людськими словами, чого бракує', () => {
  assert.match(bot.out, /не заповнено DATABASE_URL, TELEGRAM_BOT_TOKEN/);
  assert.match(bot.out, /Що робити:/);
});

test('...і не доходить ні до Telegram, ні до бази', () => {
  assert.ok(!/getUpdates|ReferenceError|TypeError/.test(bot.out), bot.out.slice(0, 400));
});

test('інжест із порожнім конфігом не стартує', () => {
  assert.equal(poll.code, 1);
});

test('...і називає всі чотири змінні, потрібні саме йому', () => {
  assert.match(poll.out, /не заповнено DATABASE_URL, BINOTEL_API_KEY, BINOTEL_API_SECRET, OPENAI_API_KEY/);
});

test('...і не намагається мігрувати базу до перевірки', () => {
  assert.ok(!/ECONNREFUSED|does not support SSL|ReferenceError/.test(poll.out), poll.out.slice(0, 400));
});
