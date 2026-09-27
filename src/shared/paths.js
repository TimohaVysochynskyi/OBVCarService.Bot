import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start) {
  let dir = start;
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('не знайдено кореня репозиторію: немає package.json у жодній батьківській теці');
    dir = up;
  }
  return dir;
}

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

const dataDir = (...parts) => join(REPO_ROOT, 'data', ...parts);

export { dataDir };
