import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SRC, readSrc } from '../helpers/repo.js';

const NETWORK_GATE = 'core/http.js';

function walk(dir, hits = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, hits);
    else if (name.endsWith('.js')) hits.push(path.relative(SRC, full).replace(/\\/g, '/'));
  }
  return hits;
}

const sources = walk(path.join(ROOT, 'src'));

test('сирого fetch поза єдиною точкою мережі немає', () => {
  const offenders = sources
    .filter((f) => f !== NETWORK_GATE && f !== 'bot/site/app.js')
    .filter((f) => /\bfetch\(/.test(readSrc(f)));
  assert.deepEqual(offenders, [], `fetch поза ${NETWORK_GATE}: ${offenders.join(', ')}`);
});

test('усі запити в http.js ідуть із таймаутом', () => {
  const gate = readSrc(NETWORK_GATE);
  const calls = [...gate.matchAll(/\bfetch\([\s\S]{0,160}?\)/g)].map((m) => m[0]);
  assert.ok(calls.length > 0);
  for (const call of calls) assert.match(call, /AbortSignal\.timeout/);
});

test('ffmpeg теж під таймаутом, включно з кешованою пробою', () => {
  const ffmpeg = readSrc('core/ffmpeg.js');
  assert.match(ffmpeg, /FFMPEG_TIMEOUT_MS/);
  assert.match(ffmpeg, /-version/);
});

test('адреса OpenAI відома лише порту', () => {
  const offenders = sources
    .filter((f) => !f.startsWith('platform/openai/'))
    .filter((f) => /api\.openai\.com/.test(readSrc(f)));
  assert.deepEqual(offenders, [], `URL повз порт: ${offenders.join(', ')}`);
});

test('ключ підставляє в запит лише порт — решті дозволено хіба перевірити його наявність', () => {
  const offenders = sources
    .filter((f) => !f.startsWith('platform/openai/'))
    .filter((f) => /Bearer \$\{[^}]*apiKey/.test(readSrc(f)));
  assert.deepEqual(offenders, [], `ключ у чужому запиті: ${offenders.join(', ')}`);
  assert.match(readSrc('bot/health.js'), /if \(!config\.openai\.apiKey\)/);
});

test('кожен виклик моделі йде через порт, а не через сирий fetchOk', () => {
  const offenders = sources
    .filter((f) => !f.startsWith('platform/openai/'))
    .filter((f) => /fetchOk\(\s*['"]openai['"]/.test(readSrc(f)));
  assert.deepEqual(offenders, [], `сирий виклик OpenAI: ${offenders.join(', ')}`);
});

test('ліміт токенів на хвилину має рівно одну реалізацію', () => {
  const client = readSrc('platform/openai/client.js');
  assert.match(client, /const WINDOW_MS = 60_000;/);
  assert.match(client, /function waitMsFor/);
  const others = sources.filter((f) => f !== 'platform/openai/client.js' && /30_000|30000/.test(readSrc(f)))
    .filter((f) => /токен|TPM|tpm/.test(readSrc(f)));
  assert.deepEqual(others, [], `друга черга лімітів: ${others.join(', ')}`);
});

test('точка підміни транспорту існує рівно одна і не вживається в src', () => {
  assert.match(readSrc('platform/openai/client.js'), /function useTransport\(fn\)/);
  const users = sources.filter((f) => f !== 'platform/openai/client.js' && /useTransport/.test(readSrc(f)));
  assert.deepEqual(users, [], `підміна транспорту в робочому коді: ${users.join(', ')}`);
});
