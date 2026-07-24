import 'dotenv/config';
import { migrate, updateClientNumberIfMissing, getEarliestCallTime } from '../core/store.js';
import { listCallsForPeriod } from '../core/binotel.js';

// One-off: the CLIENT's phone number (Binotel's externalNumber) was never captured before
// 2026-07-24 - the archive's call-detail screen had nothing to show but the internal call id,
// which reads confusingly like a phone number (see CLAUDE.md "Поточний статус"). Fresh ingests
// now save it directly; this script re-sweeps Binotel's call list for every row already in our DB
// and fills in the gap. Cheap: only list-of-calls-for-period + DB writes, no transcription/LLM.
// Idempotent (only ever fills client_number where it's still NULL) - safe to re-run, e.g. after a
// concurrent historical backfill (npm run backfill) has added more rows for the same period.
const MAX_CHUNK_MS = 23 * 60 * 60 * 1000; // Binotel's 24h cap on this endpoint

function splitIntoChunks(start, end) {
  const chunks = [];
  let chunkStart = start;
  while (chunkStart < end) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + MAX_CHUNK_MS, end.getTime()));
    chunks.push([chunkStart, chunkEnd]);
    chunkStart = chunkEnd;
  }
  return chunks;
}

async function main() {
  await migrate();

  const earliest = await getEarliestCallTime();
  if (!earliest) {
    console.log('[backfillClientNumbers] no calls in the DB yet. Nothing to do.');
    process.exit(0);
  }
  const start = new Date(earliest);
  const end = new Date();
  const chunks = splitIntoChunks(start, end);
  console.log(`[backfillClientNumbers] sweeping ${start.toISOString()} -> ${end.toISOString()} (${chunks.length} chunk(s))`);

  let filled = 0;
  let seen = 0;
  for (const [chunkStart, chunkEnd] of chunks) {
    const calls = await listCallsForPeriod(chunkStart, chunkEnd);
    for (const c of calls) {
      seen += 1;
      if (!c.clientNumber) continue;
      const n = await updateClientNumberIfMissing(c.generalCallId, c.clientNumber);
      if (n > 0) filled += 1;
    }
    console.log(`[backfillClientNumbers]   chunk ${chunkStart.toISOString()} -> ${chunkEnd.toISOString()}: ${calls.length} call(s) from Binotel, ${filled} filled so far`);
  }

  console.log(`\n[backfillClientNumbers] done: ${seen} call(s) seen from Binotel, ${filled} row(s) filled.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
