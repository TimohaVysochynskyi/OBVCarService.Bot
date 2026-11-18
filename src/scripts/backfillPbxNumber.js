import 'dotenv/config';
import { getEarliestCallTime, getPbxNumberStats, updatePbxNumberIfMissing } from '../features/ingest/repo.js';
import { migrate } from '../platform/db/pool.js';
import { listCallsForPeriod } from '../platform/binotel/client.js';
import { formatLinePhone } from '../features/operators/display.js';
import { config } from '../shared/config.js';

const MAX_CHUNK_MS = 23 * 60 * 60 * 1000;
const PAUSE_MS = config.poll.chunkPauseMs;

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
    const label = row.pbxNumber === 'невідомо' ? 'номер не збережено' : formatLinePhone(row.pbxNumber);
    console.log(`  ${String(row.count).padStart(5)}  ${label}`);
  }
}

async function main() {
  await migrate();

  console.log('[backfillPbxNumber] стан до прогону:');
  printStats(await getPbxNumberStats());

  const earliest = await getEarliestCallTime();
  if (!earliest) {
    console.log('[backfillPbxNumber] дзвінків у базі немає');
    return;
  }

  const chunks = splitIntoChunks(new Date(earliest), new Date());
  console.log(`[backfillPbxNumber] прохід по ${chunks.length} чанк(ах), без жодного звернення до OpenAI чи ElevenLabs`);

  let filled = 0;
  let seen = 0;
  let withoutNumber = 0;
  let failedChunks = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const [chunkStart, chunkEnd] = chunks[i];
    try {
      const calls = await listCallsForPeriod(chunkStart, chunkEnd);
      for (const c of calls) {
        seen += 1;
        if (!c.pbxNumber) {
          withoutNumber += 1;
          continue;
        }
        filled += await updatePbxNumberIfMissing(c.generalCallId, c.pbxNumber);
      }
    } catch (err) {
      failedChunks += 1;
      console.error(`[backfillPbxNumber] чанк ${chunkStart.toISOString().slice(0, 10)} не вдався: ${err.message.slice(0, 160)}`);
    }

    if ((i + 1) % 20 === 0) console.log(`[backfillPbxNumber] … ${i + 1}/${chunks.length}, проставлено ${filled}`);
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  console.log('\n[backfillPbxNumber] --- РЕЗУЛЬТАТ ---');
  console.log(`  переглянуто в Binotel:   ${seen}`);
  console.log(`  проставлено номер лінії: ${filled}`);
  console.log(`  Binotel не дав номера:   ${withoutNumber}`);
  console.log(`  чанків не вдалося:       ${failedChunks}`);
  console.log('\n[backfillPbxNumber] стан після прогону:');
  printStats(await getPbxNumberStats());

  if (failedChunks) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('[backfillPbxNumber] впав:', err);
    process.exit(1);
  });
