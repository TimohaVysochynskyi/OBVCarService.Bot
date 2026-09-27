import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SRC, readSrc, readRepo } from '../helpers/repo.js';

const CONFIG = 'shared/config.js';

function walk(dir, hits = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, hits);
    else if (name.endsWith('.js')) hits.push(path.relative(SRC, full).replace(/\\/g, '/'));
  }
  return hits;
}

const sources = walk(path.join(ROOT, 'src'));
const configSrc = readSrc(CONFIG);

test('process.env читається рівно в одному модулі', () => {
  const readers = sources.filter((f) => f !== CONFIG && /process\.env/.test(readSrc(f)));
  assert.deepEqual(readers, [], `env читають повз конфіг: ${readers.join(', ')}`);
});

test('конфіг читає env лише через власний хелпер', () => {
  const reads = [...configSrc.matchAll(/process\.env[^\s;)]*/g)].map((m) => m[0]);
  assert.deepEqual(reads, ['process.env[name]'], `сирі читання: ${reads.join(', ')}`);
});

test('конфіг нічого не імпортує — він фундамент, а не учасник', () => {
  assert.ok(!/^import /m.test(configSrc), 'shared/config.js має лишатись без залежностей');
});

test('значення заморожені на всю глибину, тож ніхто не змінить їх на льоту', () => {
  assert.match(configSrc, /function deepFreeze/);
  assert.match(configSrc, /const config = deepFreeze\(\{/);
});

test('обидві точки входу перевіряють обовʼязкові змінні до першої дії', () => {
  for (const [entry, groups] of [
    ['apps/bot/index.js', "['db', 'telegram']"],
    ['apps/poller/index.js', "['db', 'binotel', 'openai', 'elevenlabs']"],
  ]) {
    const src = readSrc(entry);
    assert.ok(src.includes(`missingConfig(${groups})`), `${entry}: немає перевірки ${groups}`);
    assert.match(src, /process\.exit\(1\)/);
    assert.ok(src.indexOf('missingConfig(') < src.indexOf('async function main'), `${entry}: перевірка має бути до старту`);
  }
});

test('зауваження про підозрілі значення друкуються, а не ковтаються', () => {
  for (const entry of ['apps/bot/index.js', 'apps/poller/index.js']) {
    assert.match(readSrc(entry), /for \(const issue of configIssues\(\)\)/);
  }
});

test('текст про незаповнені змінні живе в errorTexts, а не в конфігу', () => {
  assert.match(readSrc('shared/errorTexts.js'), /missingEnv: \(names\)/);
  assert.ok(!/\.env/.test(configSrc.replace(/process\.env\[name\]/g, '')), 'конфіг не пояснює помилки сам');
});

test('кожна змінна конфігу задокументована в .env.example, і навпаки', () => {
  const known = new Set([...configSrc.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]));
  const documented = new Set([...readRepo('.env.example').matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const undocumented = [...known].filter((n) => !documented.has(n));
  const orphaned = [...documented].filter((n) => !known.has(n));
  assert.deepEqual(undocumented, [], `немає в .env.example: ${undocumented.join(', ')}`);
  assert.deepEqual(orphaned, [], `у .env.example є, а код не читає: ${orphaned.join(', ')}`);
});
