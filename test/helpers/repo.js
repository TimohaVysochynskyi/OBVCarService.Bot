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

const bytes = (s) => Buffer.byteLength(s, 'utf8');

export { ROOT, SRC, readRepo, readSrc, readJson, sliceFunction, escapeClass, classesIn, orphanClasses, bytes };
