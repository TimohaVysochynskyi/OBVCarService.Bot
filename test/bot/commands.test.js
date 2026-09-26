import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SRC, readSrc } from '../helpers/repo.js';

const BOT = `${SRC}bot/`;
const index = readSrc('bot/index.js');
const access = readSrc('bot/access.js');
const TG_RULE = /^[a-z0-9_]{1,32}$/;
const declared = [...index.matchAll(/command:\s*'([^']+)'/g)].map((m) => m[1]);

test('усі нативні команди відповідають правилу Telegram', () => {
  assert.ok(declared.length >= 10, 'реєстр команд не знайдено');
  for (const c of declared) {
    assert.ok(TG_RULE.test(c), `Telegram не прийме команду "${c}": дозволені лише малі літери, цифри й підкреслення`);
  }
});

test('усі зареєстровані хендлери команд теж валідні', () => {
  const registered = [...index.matchAll(/bot\.command\('([^']+)'/g)].map((m) => m[1]);
  const inModules = fs.readdirSync(BOT).filter((f) => f.endsWith('.js'))
    .flatMap((f) => [...fs.readFileSync(BOT + f, 'utf8').matchAll(/bot\.command\('([^']+)'/g)].map((m) => m[1]));
  for (const c of new Set([...registered, ...inModules])) {
    assert.ok(TG_RULE.test(c), `хендлер зареєстрований на недопустиму команду "${c}"`);
  }
});

test('кожна оголошена команда має гейт доступу', () => {
  for (const c of declared) {
    assert.ok(access.includes(`${c}:`) || access.includes(`'${c}'`), `команда "${c}" не має запису в featureOf`);
  }
});

test('команда звіту — globalreport, без дефіса', () => {
  assert.ok(declared.includes('globalreport'));
});

test('дефісної форми в реєстрі не лишилось', () => {
  assert.ok(!index.includes("'global-report'"));
});
