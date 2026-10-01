import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SRC, readSrc } from '../helpers/repo.js';

const BACKSLASH = String.fromCharCode(92);

function walk(dir = SRC, hits = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, hits);
    else if (name.endsWith('.js')) hits.push(path.relative(SRC, full).replace(/\\/g, '/'));
  }
  return hits;
}

function stripLiterals(src) {
  let out = '';
  let i = 0;
  let prev = '';
  const modes = [{ template: false, depth: 0 }];
  while (i < src.length) {
    const top = modes[modes.length - 1];
    const ch = src[i];
    if (top.template) {
      if (ch === BACKSLASH) { i += 2; continue; }
      if (ch === '`') { modes.pop(); i += 1; out += '""'; prev = '"'; continue; }
      if (ch === '$' && src[i + 1] === '{') { modes.push({ template: false, depth: 0 }); i += 2; prev = '('; continue; }
      i += 1;
      continue;
    }
    if (ch === '`') { modes.push({ template: true, depth: 0 }); i += 1; continue; }
    if (ch === '{') top.depth += 1;
    if (ch === '}') {
      if (top.depth > 0) top.depth -= 1;
      else if (modes.length > 1) { modes.pop(); i += 1; out += '""'; prev = '"'; continue; }
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === BACKSLASH) i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      prev = '"';
      continue;
    }
    if (ch === '/' && prev && '=(,:[!&|?{};+-*%'.includes(prev)) {
      let j = i + 1;
      let closed = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === BACKSLASH) { j += 2; continue; }
        if (src[j] === '/') { closed = true; break; }
        j += 1;
      }
      if (closed) {
        i = j + 1;
        while (i < src.length && 'gimsuyd'.includes(src[i])) i += 1;
        out += 'RE';
        prev = 'E';
        continue;
      }
    }
    out += ch;
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return out;
}

const GLOBALS = new Set([
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Error', 'TypeError',
  'RangeError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Symbol', 'BigInt',
  'Infinity', 'NaN', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortSignal', 'AbortController', 'Blob', 'FormData', 'File', 'Headers', 'Request', 'Response',
  'Intl', 'Function', 'Proxy', 'Reflect', 'ArrayBuffer', 'Uint8Array', 'Int32Array', 'DataView',
]);

const ID = /[A-Za-z_$][\w$]*/g;

function declaredNames(src) {
  const names = new Set();
  const add = (text) => {
    for (const m of text.matchAll(ID)) if (m[0] !== 'as') names.add(m[0]);
  };
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+""/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) add(m[1]);
  for (const m of src.matchAll(/,\s*([A-Z][A-Z0-9_]{2,})\s*=/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bfunction\s*\*?\s*[\w$]*\s*\(([\s\S]*?)\)\s*{/g)) add(m[1]);
  for (const m of src.matchAll(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*{/gm)) {
    names.add(m[1]);
    add(m[2]);
  }
  return names;
}

function undeclaredConstants(file) {
  const stripped = stripLiterals(readSrc(file));
  const declared = declaredNames(stripped);
  const found = new Set();
  for (const m of stripped.matchAll(/(^|[^.\w$"])([A-Z][A-Z0-9_]{2,})\b/g)) {
    const name = m[2];
    if (declared.has(name) || GLOBALS.has(name)) continue;
    const after = stripped.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (/^\s*:/.test(after)) continue;
    found.add(name);
  }
  return [...found];
}

test('жодна константа в src/ не використовується без оголошення або імпорту', () => {
  const broken = [];
  for (const file of walk()) {
    for (const name of undeclaredConstants(file)) broken.push(`${file}: ${name}`);
  }
  assert.deepEqual(broken, [], `константа без імпорту падає лише під час виконання:\n${broken.join('\n')}`);
});
