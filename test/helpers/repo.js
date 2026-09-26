import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = `${ROOT}src/`;

const readRepo = (rel) => fs.readFileSync(ROOT + rel, 'utf8');
const readSrc = (rel) => fs.readFileSync(SRC + rel, 'utf8');
const readJson = (rel) => JSON.parse(readSrc(rel));

function sliceFunction(src, signature) {
  const from = src.indexOf(signature);
  if (from < 0) throw new Error(`не знайшов функцію ${signature}`);
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error(`не знайшов кінець функції ${signature}`);
}

const CSS_SPECIAL = /[:.\/\[\]%(),#>=*+~'"!$^&|{}?\\@]/g;
const escapeClass = (name) => `.${name.replace(CSS_SPECIAL, (ch) => `\\${ch}`)}`;

const classesIn = (html) =>
  new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));

function orphanClasses(html, css, appJs = '') {
  const used = classesIn(html);
  for (const m of appJs.matchAll(/classList\.toggle\('([^']+)'/g)) used.add(m[1]);
  return { used, orphans: [...used].filter((c) => !css.includes(escapeClass(c))) };
}

const REPOS = [
  'platform/db/pool.js', 'platform/db/state.js', 'platform/db/filters.js',
  'features/ingest/repo.js', 'features/analysis/repo.js', 'features/operators/repo.js',
  'features/reporting/repo.js', 'features/archive/repo.js', 'features/access/repo.js',
  'features/ops/repo.js', 'features/knowledge-base/repo.js',
];

const allRepos = () => REPOS.map((f) => fs.readFileSync(SRC + f, 'utf8')).join('\n');

const MIGRATIONS = `${SRC}platform/db/migrations/`;

function migrationsSql() {
  return fs.readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(MIGRATIONS + f, 'utf8'))
    .join('\n');
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');

export { ROOT, SRC, MIGRATIONS, REPOS, allRepos, readRepo, readSrc, readJson, migrationsSql, sliceFunction, escapeClass, classesIn, orphanClasses, bytes };
