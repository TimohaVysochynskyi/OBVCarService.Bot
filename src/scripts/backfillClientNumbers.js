import 'dotenv/config';
import { migrate, updateClientInfoIfMissing, getEarliestCallTime } from '../core/store.js';
import { listCallsForPeriod } from '../core/binotel.js';

const MAX_CHUNK_MS = 23 * 60 * 60 * 1000;

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
  let failedChunks = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const [chunkStart, chunkEnd] = chunks[i];
    try {
      const calls = await listCallsForPeriod(chunkStart, chunkEnd);
      for (const c of calls) {
        seen += 1;
        if (!c.clientNumber && !c.clientName) continue;
        const n = await updateClientInfoIfMissing(c.generalCallId, c.clientNumber, c.clientName);
        if (n > 0) filled += 1;
      }
      console.log(`[backfillClientNumbers]   chunk ${chunkStart.toISOString()} -> ${chunkEnd.toISOString()}: ${calls.length} call(s) from Binotel, ${filled} filled so far`);
    } catch (err) {
      failedChunks += 1;
      console.error(`[backfillClientNumbers]   chunk ${chunkStart.toISOString()} -> ${chunkEnd.toISOString()} FAILED: ${err.message}`);
    }
    if (i < chunks.length - 1) await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  console.log(`\n[backfillClientNumbers] done: ${seen} call(s) seen from Binotel, ${filled} row(s) filled, ${failedChunks} chunk(s) failed (re-run to retry them).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
