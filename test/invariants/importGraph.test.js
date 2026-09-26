import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readRepo } from '../helpers/repo.js';

const SKIP = new Set(['node_modules', '.git', 'data', 'report-site', 'temp', '.vscode', 'test']);
const BROWSER_ASSETS = ['src/bot/site/app.js'];

function walk(dir, hits = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, hits);
    else if (/\.(js|cjs|mjs)$/.test(name)) hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return hits;
}

const files = walk(ROOT);
const pkg = JSON.parse(readRepo('package.json'));
const scriptEntries = Object.values(pkg.scripts || {})
  .map((cmd) => /node\s+([^\s]+\.js)/.exec(cmd))
  .filter(Boolean)
  .map((m) => m[1]);
const entries = [...new Set([...scriptEntries, 'ecosystem.config.cjs'])];

const relativeDeps = (rel) => {
  const src = readRepo(rel);
  const dir = path.dirname(path.join(ROOT, rel));
  return [
    ...[...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
  ].map((d) => path.relative(ROOT, path.resolve(dir, d)).replace(/\\/g, '/'));
};

const reachable = new Set();
const queue = [...entries];
while (queue.length) {
  const cur = queue.shift();
  if (reachable.has(cur) || !files.includes(cur)) continue;
  reachable.add(cur);
  for (const dep of relativeDeps(cur)) queue.push(dep);
}

const bareImports = new Set();
for (const rel of files) {
  const src = readRepo(rel);
  for (const m of src.matchAll(/(?:from|import)\s+['"]([^.'"][^'"]*)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('node:')) continue;
    bareImports.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
}

test('кожен npm-скрипт вказує на наявний файл', () => {
  const missing = Object.entries(pkg.scripts || {})
    .map(([name, cmd]) => [name, /node\s+([^\s]+\.js)/.exec(cmd)])
    .filter(([, m]) => m && !files.includes(m[1]))
    .map(([name, m]) => `${name} → ${m[1]}`);
  assert.deepEqual(missing, [], `скрипти без файлу: ${missing.join(', ')}`);
});

test('до кожного файлу src є шлях від точки входу', () => {
  const orphans = files.filter((f) => f.startsWith('src/') && !reachable.has(f) && !BROWSER_ASSETS.includes(f));
  assert.deepEqual(orphans, [], `мертві файли: ${orphans.join(', ')}`);
});

test('статика сторінки звіту навмисно поза графом імпортів', () => {
  for (const asset of BROWSER_ASSETS) {
    assert.ok(files.includes(asset), `зник ${asset}`);
    assert.ok(!reachable.has(asset));
  }
  assert.match(readRepo('src/bot/globalReportBundle.js'), /site/);
});

test('кожен зовнішній пакет оголошений у package.json', () => {
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const undeclared = [...bareImports].filter((d) => !declared.has(d));
  assert.deepEqual(undeclared, [], `імпортується, але не оголошено: ${undeclared.join(', ')}`);
});

test('обидва процеси pm2 стартують із наявних файлів', () => {
  const config = readRepo('ecosystem.config.cjs');
  const scripts = [...config.matchAll(/script: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['src/bot/index.js', 'src/jobs/index.js']);
  for (const s of scripts) assert.ok(files.includes(s), `pm2 вказує на неіснуючий ${s}`);
});
