import 'dotenv/config';
import { migrate } from '../core/store.js';
import { processCallsForRange } from '../jobs/processCalls.js';

async function main() {
  const [startArg, endArg] = process.argv.slice(2);
  if (!startArg || !endArg) {
    throw new Error('Usage: node src/scripts/backfill.js "<start date/time>" "<end date/time>"');
  }

  const start = new Date(startArg);
  const end = new Date(endArg);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Could not parse one of the dates - try a format like "2026-07-01 00:00:00"');
  }
  if (start >= end) {
    throw new Error('Start must be before end');
  }

  await migrate();
  await processCallsForRange(start, end);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
