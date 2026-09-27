import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SRC, readSrc } from '../helpers/repo.js';

function walk(dir = SRC, hits = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, hits);
    else if (name.endsWith('.js')) hits.push(path.relative(SRC, full).replace(/\\/g, '/'));
  }
  return hits;
}

const sources = walk();

function depsOf(file) {
  const src = readSrc(file);
  return [
    ...[...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
  ].map((d) => path.posix.normalize(path.posix.join(path.posix.dirname(file), d)));
}

const layerOf = (file) => file.split('/')[0];
const PROMPT_REGISTRY = 'features/prompts/registry.js';

test('усі шари на місці, і кожен файл належить якомусь із них', () => {
  const layers = new Set(sources.map(layerOf));
  assert.deepEqual([...layers].sort(), ['apps', 'domain', 'features', 'platform', 'scripts', 'shared']);
});

test('shared нічого не знає ні про домен, ні про слайси', () => {
  const offenders = [];
  for (const file of sources.filter((f) => layerOf(f) === 'shared')) {
    for (const dep of depsOf(file)) {
      if (['features', 'domain', 'platform', 'apps'].includes(layerOf(dep))) offenders.push(`${file} → ${dep}`);
    }
  }
  assert.deepEqual(offenders, [], `shared тягне вище: ${offenders.join(', ')}`);
});

test('domain не робить I/O: жодного імпорту platform, apps чи чужого слайсу', () => {
  const offenders = [];
  for (const file of sources.filter((f) => layerOf(f) === 'domain')) {
    for (const dep of depsOf(file)) {
      if (dep === PROMPT_REGISTRY) continue;
      if (['platform', 'apps', 'features', 'scripts'].includes(layerOf(dep))) offenders.push(`${file} → ${dep}`);
    }
  }
  assert.deepEqual(offenders, [], `домен тягне I/O: ${offenders.join(', ')}`);
});

test('єдиний виняток домену названий поіменно: реєстр промптів', () => {
  const users = sources
    .filter((f) => layerOf(f) === 'domain')
    .filter((f) => depsOf(f).includes(PROMPT_REGISTRY));
  assert.deepEqual(users.sort(), ['domain/call/intro.js', 'domain/call/purpose.js']);
  assert.ok(fs.existsSync(path.join(SRC, PROMPT_REGISTRY)));
});

test('domain не тримає SQL і не ходить у мережу', () => {
  for (const file of sources.filter((f) => layerOf(f) === 'domain')) {
    const src = readSrc(file);
    assert.ok(!/\.query\(/.test(src), `${file} робить запит до бази`);
    assert.ok(!/fetch\(|fetchOk\(/.test(src), `${file} ходить у мережу`);
  }
});

test('platform не знає про слайси — виняток лише локальний архів аудіо', () => {
  const offenders = [];
  for (const file of sources.filter((f) => layerOf(f) === 'platform')) {
    for (const dep of depsOf(file)) {
      if (layerOf(dep) === 'features' && file !== 'platform/audio/store.js') offenders.push(`${file} → ${dep}`);
      if (layerOf(dep) === 'apps') offenders.push(`${file} → ${dep}`);
    }
  }
  assert.deepEqual(offenders, [], `platform тягне слайси: ${offenders.join(', ')}`);
});

test('ніхто не імпортує точки входу', () => {
  const offenders = [];
  for (const file of sources) {
    for (const dep of depsOf(file)) {
      if (layerOf(dep) === 'apps') offenders.push(`${file} → ${dep}`);
    }
  }
  assert.deepEqual(offenders, [], `apps імпортують: ${offenders.join(', ')}`);
});

test('точки входу лишились тонкими', () => {
  for (const entry of ['apps/bot/index.js', 'apps/poller/index.js']) {
    const lines = readSrc(entry).split('\n').length;
    assert.ok(lines < 420, `${entry} розрісся до ${lines} рядків — логіці місце у слайсі`);
  }
});

test('кожен слайс має репозиторій, і жоден файл не лишився в старих теках', () => {
  const slices = [...new Set(sources.filter((f) => layerOf(f) === 'features').map((f) => f.split('/')[1]))];
  const withoutRepo = slices.filter((s) => !sources.includes(`features/${s}/repo.js`)).sort();
  assert.deepEqual(withoutRepo, ['menu', 'prompts'],
    'слайс без repo.js мусить бути названий тут: menu — це лише клавіатура, prompts тримає тексти в app_state через platform/db/state.js');
  for (const dead of ['core', 'bot', 'jobs']) {
    assert.ok(!fs.existsSync(path.join(SRC, dead)), `тека ${dead} мала зникнути`);
  }
});

test('шлях до кореня репозиторію рахується один раз і не залежить від глибини файлу', () => {
  const paths = readSrc('shared/paths.js');
  assert.match(paths, /package\.json/);
  const counters = sources
    .filter((f) => f !== 'shared/paths.js')
    .filter((f) => /\.\.',\s*'\.\.'|\.\.\/\.\.\/data/.test(readSrc(f)));
  assert.deepEqual(counters, [], `рахують '..' самі: ${counters.join(', ')}`);
});
