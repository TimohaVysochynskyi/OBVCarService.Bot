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
