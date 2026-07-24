import 'dotenv/config';
import { migrate, reassignCallsByExtension, renameManagerEverywhere, deleteCallsByExtension, clearAllReportSegments } from '../core/store.js';

// One-off fix for the 2026-07 manager-identity bug (see CLAUDE.md "Ідентифікація оператора"):
// personal extensions (903/904/905) occasionally arrived from Binotel without employeeData.name,
// which fell through to content-based identification and sometimes misattributed the call to a
// DIFFERENT manager (or left it as a bare-number bucket); on top of that, the director's mobile
// (0674738200, no employeeData at all) was polluting real managers' history the same way. The
// code fix (src/jobs/processCalls.js: PERSONAL_OPERATORS / EXCLUDED_EXTENSIONS) stops this from
// recurring; this script repairs the calls already sitting in the DB. Safe to re-run (idempotent -
// once names match, the UPDATEs affect 0 rows and the excluded extension has nothing left to delete).
const PERSONAL_OPERATORS = { '903': 'Роман', '904': 'Андрій', '905': 'Володимир' };
const RENAMES = [
  ['Андрей', 'Андрій'], // RU -> UK spelling, covers shared-line (901/902) calls identifyManager already matched under the old spelling
  ['Владимир', 'Володимир'],
];
const EXCLUDED_EXTENSIONS = ['0674738200']; // director's mobile - not a salesperson, never evaluated

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
