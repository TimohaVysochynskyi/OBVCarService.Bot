import 'dotenv/config';
import { migrate, reassignCallsByExtension, renameManagerEverywhere, deleteCallsByExtension, clearAllReportSegments } from '../core/store.js';

const PERSONAL_OPERATORS = { '903': 'Роман', '904': 'Андрій', '905': 'Володимир' };
const RENAMES = [
  ['Андрей', 'Андрій'],
  ['Владимир', 'Володимир'],
];
const EXCLUDED_EXTENSIONS = ['0674738200'];

async function main() {
  await migrate();

  console.log('[normalizeOperators] reassigning personal-extension calls by extension number...');
  for (const [ext, name] of Object.entries(PERSONAL_OPERATORS)) {
    const n = await reassignCallsByExtension(ext, name);
    console.log(`[normalizeOperators]   ext ${ext} -> "${name}": ${n} row(s)`);
  }

  console.log('[normalizeOperators] normalizing remaining old-spelling calls (shared-line matches)...');
  for (const [oldName, newName] of RENAMES) {
    const n = await renameManagerEverywhere(oldName, newName);
    console.log(`[normalizeOperators]   "${oldName}" -> "${newName}": ${n} row(s)`);
  }

  console.log('[normalizeOperators] deleting excluded-extension calls...');
  for (const ext of EXCLUDED_EXTENSIONS) {
    const n = await deleteCallsByExtension(ext);
    console.log(`[normalizeOperators]   ext ${ext}: ${n} call(s) deleted`);
  }

  console.log('[normalizeOperators] clearing cached report_segments (will recompute fresh)...');
  const cleared = await clearAllReportSegments();
  console.log(`[normalizeOperators]   ${cleared} segment(s) cleared`);

  console.log('[normalizeOperators] done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
