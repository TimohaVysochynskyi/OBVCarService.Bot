import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from '../../helpers/repo.js';

const src = readSrc('features/ingest/process.js');

test('пауза між чанками береться з конфігу, а не з власного розбору env', () => {
  assert.match(src, /function chunkPauseMs\(\) \{\s*\n\s*return config\.poll\.chunkPauseMs;/);
});

test('ліміт спроб черги теж із конфігу', () => {
  assert.match(src, /MAX_PENDING_ATTEMPTS = config\.poll\.maxPendingAttempts/);
});

test('помилка лістингу валить весь діапазон, а не пропускає вікно', () => {
  const loop = src.match(/async function processCallsForRange[\s\S]*?\n\}/)[0];
  assert.ok(!/catch/.test(loop), 'у циклі діапазону не має бути catch — пропущене вікно = тихо втрачені дзвінки');
});

test('лістинг чанка теж не глушиться', () => {
  const chunk = src.match(/async function processChunk[\s\S]*?\n\}/)[0];
  assert.ok(!/catch/.test(chunk.split('for (const call')[0]), 'лістинг чанка не обгорнутий у catch');
});
