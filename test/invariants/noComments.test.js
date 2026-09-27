import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/repo.js';

const BACKSLASH = String.fromCharCode(92);
const SKIP = new Set(['node_modules', '.git', 'data', 'report-site', 'temp', '.vscode']);

function walk(dir, hits = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, hits);
    else if (/\.(js|cjs|mjs)$/.test(name)) hits.push(full);
  }
  return hits;
}

function commentsIn(src) {
  const found = [];
  let i = 0;
  let mode = 'code';
  let quote = '';
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n') line += 1;
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        found.push(`${line}: рядковий коментар`);
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && n === '*') {
        found.push(`${line}: блоковий коментар`);
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') line += 1;
          i += 1;
        }
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        mode = 'str';
        quote = c;
        i += 1;
        continue;
      }
      if (c === '/') {
        const before = src.slice(0, i).replace(/\s+$/, '');
        const last = before[before.length - 1];
        if (last && !/[\w)\]]/.test(last)) {
          mode = 'rx';
          i += 1;
          continue;
        }
      }
    } else if (mode === 'str') {
      if (c === BACKSLASH) { i += 2; continue; }
      if (c === quote) mode = 'code';
    } else if (mode === 'rx') {
      if (c === BACKSLASH) { i += 2; continue; }
      if (c === '[') {
        while (i < src.length && src[i] !== ']') {
          if (src[i] === BACKSLASH) i += 1;
          i += 1;
        }
      } else if (c === '/' || c === '\n') mode = 'code';
    }
    i += 1;
  }
  return found;
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'test')), path.join(ROOT, 'ecosystem.config.cjs')];

test('у коді проєкту немає жодного коментаря', () => {
  const bad = [];
  for (const file of files) {
    for (const hit of commentsIn(fs.readFileSync(file, 'utf8'))) {
      bad.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${hit}`);
    }
  }
  assert.deepEqual(bad, [], `коментарі знайдено:\n${bad.join('\n')}`);
});

test('прибирання коментарів не лишило керуючих символів у коді', () => {
  const damaged = files
    .filter((f) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  assert.deepEqual(damaged, [], `керуючі символи: ${damaged.join(', ')}`);
});

test('тексти промптів лишились цілими після чистки коментарів', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'src/features/prompts/defaults.json'), 'utf8');
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw));
  const prompts = JSON.parse(raw);
  for (const [key, lines] of Object.entries(prompts)) {
    assert.ok(Array.isArray(lines) && lines.length > 0, `порожній промпт: ${key}`);
    for (const line of lines) assert.equal(typeof line, 'string', `не рядок у промпті ${key}`);
  }
});

test('перевірка охоплює і src, і test, і конфіг pm2', () => {
  const rel = files.map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  assert.ok(rel.some((f) => f.startsWith('src/')));
  assert.ok(rel.some((f) => f.startsWith('test/')));
  assert.ok(rel.includes('ecosystem.config.cjs'));
});
