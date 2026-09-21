import 'dotenv/config';
import { migrate, updateDirectionIfMissing, getDirectionStats, getEarliestCallTime } from '../core/store.js';
import { listCallsForPeriod } from '../core/binotel.js';
import { DIRECTION_LABELS } from '../core/callDirection.js';

const MAX_CHUNK_MS = 23 * 60 * 60 * 1000;
const PAUSE_MS = Number(process.env.POLL_CHUNK_PAUSE_MS || 1500);

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

function printStats(rows) {
  for (const row of rows) {
    const label = DIRECTION_LABELS[row.direction]?.title || row.direction;
    console.log(`  ${String(row.count).padStart(5)}  ${label}`);
  }
}

async function main() {
  await migrate();

  console.log('[backfillDirection] стан до прогону:');
  printStats(await getDirectionStats());

  const earliest = await getEarliestCallTime();
  if (!earliest) {
    console.log('[backfillDirection] дзвінків у базі немає');
    return;
  }

  const chunks = splitIntoChunks(new Date(earliest), new Date());
  console.log(`[backfillDirection] прохід по ${chunks.length} чанк(ах), без жодного звернення до OpenAI`);

  let filled = 0;
  let seen = 0;
  let failedChunks = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const [chunkStart, chunkEnd] = chunks[i];
    try {
      const calls = await listCallsForPeriod(chunkStart, chunkEnd);
      for (const c of calls) {
        seen += 1;
        if (!c.direction) continue;
        filled += await updateDirectionIfMissing(c.generalCallId, c.direction);
      }
    } catch (err) {
      failedChunks += 1;
      console.error(`[backfillDirection] чанк ${chunkStart.toISOString().slice(0, 10)} не вдався: ${err.message.slice(0, 160)}`);
    }

    if ((i + 1) % 20 === 0) console.log(`[backfillDirection] … ${i + 1}/${chunks.length}, проставлено ${filled}`);
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  console.log('\n[backfillDirection] --- РЕЗУЛЬТАТ ---');
  console.log(`  переглянуто в Binotel: ${seen}`);
  console.log(`  проставлено напрямок:  ${filled}`);
  console.log(`  чанків не вдалося:     ${failedChunks}`);
  console.log('\n[backfillDirection] стан після прогону:');
  printStats(await getDirectionStats());

  if (failedChunks) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('[backfillDirection] впав:', err);
    process.exit(1);
  });
