import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readRepo } from '../helpers/repo.js';

const PAID = [
  'features/analysis/analyzeCall.js', 'features/analysis/classifyCall.js', 'features/analysis/classifyPersonal.js', 'features/analysis/clientDecline.js',
  'features/analysis/dealBlocker.js', 'features/analysis/transcribe.js', 'platform/elevenlabs/client.js', 'features/analysis/identifyManager.js',
  'features/reporting/analyze.js', 'features/reporting/segments.js', 'features/knowledge-base/kb.js',
];
const FREE_SCRIPTS = ['backfill:direction', 'backfill:intro'];

const pkg = JSON.parse(readRepo('package.json'));
const entryOf = (script) => /node\s+([^\s]+\.js)/.exec(pkg.scripts[script])[1];

function closureOf(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    seen.add(rel);
    const src = fs.readFileSync(full, 'utf8');
    const deps = [
      ...[...src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
      ...[...src.matchAll(/import\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
      ...[...src.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]),
    ];
    for (const dep of deps) {
      queue.push(path.relative(ROOT, path.resolve(path.dirname(full), dep)).replace(/\\/g, '/'));
    }
  }
  return seen;
}

for (const script of FREE_SCRIPTS) {
  test(`${script} не тягне жодного платного модуля`, () => {
    const reached = closureOf(entryOf(script));
    const paid = PAID.filter((p) => reached.has(`src/${p}`));
    assert.deepEqual(paid, [], `${script} тягне платне: ${paid.join(', ')}`);
  });

  test(`${script} не звертається до OpenAI чи ElevenLabs напряму`, () => {
    for (const rel of closureOf(entryOf(script))) {
      if (!rel.startsWith('src/')) continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(!/api\.openai\.com|api\.elevenlabs\.io/.test(src), `${rel} ходить в платний API`);
    }
  });
}

test('обидва безкоштовні беклоги досі оголошені в package.json', () => {
  for (const script of FREE_SCRIPTS) {
    assert.ok(pkg.scripts[script], `зник скрипт ${script} — перевірка втратила предмет`);
    assert.ok(fs.existsSync(path.join(ROOT, entryOf(script))), `${script} вказує на неіснуючий файл`);
  }
});
