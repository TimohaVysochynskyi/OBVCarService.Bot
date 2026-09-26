import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../helpers/repo.js';

const src = readSrc('jobs/processCalls.js');
const fnSrc = src.match(/const DEFAULT_CHUNK_PAUSE_MS[\s\S]*?function chunkPauseMs\(\)\s*\{[\s\S]*?\n\}/)[0];
const withEnv = (env) => new Function('process', `${fnSrc}; return chunkPauseMs();`)({ env });

test('дефолт паузи між чанками незмінний', () => {
  assert.equal(withEnv({}), 1500);
});

test('POLL_CHUNK_PAUSE_MS переважує', () => {
  assert.equal(withEnv({ POLL_CHUNK_PAUSE_MS: '4000' }), 4000);
});

test('0 = без паузи', () => {
  assert.equal(withEnv({ POLL_CHUNK_PAUSE_MS: '0' }), 0);
});

test('сміття в паузі → дефолт', () => {
  assert.equal(withEnv({ POLL_CHUNK_PAUSE_MS: 'abc' }), 1500);
});

test('відʼємна пауза → дефолт', () => {
  assert.equal(withEnv({ POLL_CHUNK_PAUSE_MS: '-5' }), 1500);
});

test('помилка лістингу валить весь діапазон, а не пропускає вікно', () => {
  const loop = src.match(/async function processCallsForRange[\s\S]*?\n\}/)[0];
  assert.ok(!/catch/.test(loop), 'у циклі діапазону не має бути catch — пропущене вікно = тихо втрачені дзвінки');
});

test('лістинг чанка теж не глушиться', () => {
  const chunk = src.match(/async function processChunk[\s\S]*?\n\}/)[0];
  assert.ok(!/catch/.test(chunk.split('for (const call')[0]), 'лістинг чанка не обгорнутий у catch');
});
