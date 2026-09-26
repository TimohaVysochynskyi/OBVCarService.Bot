import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SRC, REPOS, readSrc } from '../helpers/repo.js';

function walk(dir, hits = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, hits);
    else if (name.endsWith('.js')) hits.push(path.relative(SRC, full).replace(/\\/g, '/'));
  }
  return hits;
}

const sources = walk(path.join(ROOT, 'src'));
const isRepo = (f) => /^features\/[a-z-]+\/repo\.js$/.test(f);
const isDbPlatform = (f) => f.startsWith('platform/db/');

const importsOf = (file) => {
  const src = readSrc(file);
  return [
    ...[...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
  ].map((d) => path.relative(SRC, path.resolve(path.dirname(path.join(SRC, file)), d)).replace(/\\/g, '/'));
};

test('SQL живе лише в репозиторіях слайсів і в platform/db', () => {
  const offenders = sources
    .filter((f) => !isRepo(f) && !isDbPlatform(f))
    .filter((f) => /\.query\(/.test(readSrc(f)));
  assert.deepEqual(offenders, [], `запити повз репозиторій: ${offenders.join(', ')}`);
});

test('сирий пул дістають лише ті, хто має право писати SQL', () => {
  const offenders = sources
    .filter((f) => !isRepo(f) && !isDbPlatform(f))
    .filter((f) => /import \{[^}]*\bpool\b[^}]*\} from/.test(readSrc(f)));
  assert.deepEqual(offenders, [], `pool імпортують повз межу: ${offenders.join(', ')}`);
});

test('кожен слайс має рівно один репозиторій, і всі вони на місці', () => {
  const found = sources.filter(isRepo).sort();
  assert.deepEqual(found, REPOS.filter(isRepo).sort());
  for (const repo of found) assert.ok(fs.existsSync(path.join(SRC, repo)));
});

test('store.js не воскрес — жодного файлу, що знає весь SQL проєкту', () => {
  assert.ok(!fs.existsSync(path.join(SRC, 'core', 'store.js')));
  const biggest = REPOS.map((f) => [f, readSrc(f).split('\n').length]).sort((a, b) => b[1] - a[1])[0];
  assert.ok(biggest[1] < 500, `${biggest[0]} розрісся до ${biggest[1]} рядків — час ділити далі`);
});

test('репозиторій слайсу не лізе в чужий репозиторій', () => {
  const offenders = [];
  for (const repo of sources.filter(isRepo)) {
    for (const dep of importsOf(repo)) {
      if (isRepo(dep) && dep !== repo) offenders.push(`${repo} → ${dep}`);
    }
  }
  assert.deepEqual(offenders, [], `перехресні залежності репозиторіїв: ${offenders.join(', ')}`);
});

test('спільні шматки SQL оголошені в одному місці', () => {
  const filters = readSrc('platform/db/filters.js');
  for (const name of ['SALES_FILTER', 'BLOCKED_FILTER', 'NOT_BLOCKED_FILTER', 'BLOCKER_COLUMNS_SQL']) {
    assert.match(filters, new RegExp(`const ${name} =`), `${name} зник із filters.js`);
    const copies = REPOS.filter((f) => f !== 'platform/db/filters.js')
      .filter((f) => new RegExp(`const ${name} =`).test(readSrc(f)));
    assert.deepEqual(copies, [], `${name} продубльовано в ${copies.join(', ')}`);
  }
});

test('слухач помилок пулу лишається БЕЗУМОВНИМ', () => {
  const poolJs = readSrc('platform/db/pool.js');
  assert.match(poolJs, /pool\.on\('error'/);
  const before = poolJs.slice(0, poolJs.indexOf("pool.on('error'"));
  assert.ok(!/\bif\s*\(/.test(before.slice(before.indexOf('const pool'))), 'слухач опинився під умовою');
});

test('у графі імпортів немає циклів', () => {
  const state = new Map();
  const stack = [];
  const cycles = [];
  const visit = (file) => {
    if (state.get(file) === 'done') return;
    if (state.get(file) === 'open') {
      cycles.push([...stack.slice(stack.indexOf(file)), file].join(' → '));
      return;
    }
    state.set(file, 'open');
    stack.push(file);
    for (const dep of importsOf(file)) {
      if (sources.includes(dep)) visit(dep);
    }
    stack.pop();
    state.set(file, 'done');
  };
  for (const file of sources) visit(file);
  assert.deepEqual(cycles, [], `цикли: ${cycles.join(' | ')}`);
});
