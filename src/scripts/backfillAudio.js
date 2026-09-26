import 'dotenv/config';
import { migrate, getCallsMissingAudio, setCallAudio, getAudioArchiveStats } from '../core/store.js';
import { fetchRecording, saveRecording, readStoredRecording, storageRoot, freeSpaceMb } from '../core/audioStore.js';


const PAUSE_MS = Number(process.env.BACKFILL_AUDIO_PAUSE_MS || 1500);
const MB = 1024 * 1024;

function parseArgs(argv) {
  const limitIdx = argv.indexOf('--limit');
  return {
    limit: limitIdx >= 0 ? Number(argv[limitIdx + 1]) : null,
    retryMissing: argv.includes('--retry-missing'),
  };
}

const fmtMb = (bytes) => `${(bytes / MB).toFixed(1)} МБ`;

async function main() {
  const { limit, retryMissing } = parseArgs(process.argv.slice(2));
  await migrate();

  const before = await getAudioArchiveStats();
  const free = await freeSpaceMb();
  console.log(`[backfillAudio] archive root: ${storageRoot()}`);
  console.log(
    `[backfillAudio] у БД ${before.total} дзвінків: збережено ${before.stored}, недоступно ${before.unavailable}, ще не пробували ${before.untried} (${fmtMb(Number(before.bytes))})`
  );
  if (free != null) console.log(`[backfillAudio] вільно на диску: ${free} МБ`);

  const calls = await getCallsMissingAudio({ limit, retryMissing });
  if (!calls.length) {
    console.log('[backfillAudio] нічого завантажувати — усі записи вже в архіві.');
    process.exit(0);
  }
  console.log(`[backfillAudio] до завантаження: ${calls.length} дзвінк(ів)${retryMissing ? ' (з повторами недоступних)' : ''}`);

  let stored = 0;
  let reused = 0;
  let unavailable = 0;
  let failed = 0;
  let bytes = 0;
  const failures = [];

  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    const label = `${i + 1}/${calls.length} ${c.generalCallId} (${c.managerName || '?'}, ${c.durationSec}s)`;
    try {
      const local = await readStoredRecording({ generalCallId: c.generalCallId, startTime: c.startTime });
      if (local) {
        const size = local.buffer.length;
        await setCallAudio(c.generalCallId, { audioPath: local.relPath, audioBytes: size, audioStatus: 'stored' });
        reused += 1;
        bytes += size;
        console.log(`[backfillAudio] ${label} — уже на диску (${fmtMb(size)})`);
        continue;
      }

      const buffer = await fetchRecording(c.generalCallId);
      if (!buffer) {
        await setCallAudio(c.generalCallId, { audioStatus: 'unavailable' });
        unavailable += 1;
        failures.push({ id: c.generalCallId, reason: 'Binotel не має запису' });
        console.warn(`[backfillAudio] ${label} — запису немає в Binotel`);
      } else {
        const saved = await saveRecording(c.generalCallId, c.startTime, buffer);
        await setCallAudio(c.generalCallId, {
          audioPath: saved.relPath,
          audioBytes: saved.bytes,
          audioStatus: 'stored',
        });
        stored += 1;
        bytes += saved.bytes;
        console.log(`[backfillAudio] ${label} — ${saved.relPath} (${fmtMb(saved.bytes)})`);
      }
    } catch (err) {
      failed += 1;
      failures.push({ id: c.generalCallId, reason: err.message });
      console.error(`[backfillAudio] ${label} — ПОМИЛКА: ${err.message}`);
    }

    if (i < calls.length - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  const after = await getAudioArchiveStats();
  console.log('\n[backfillAudio] --- РЕЗУЛЬТАТ ---');
  console.log(`  завантажено:        ${stored}`);
  console.log(`  вже було на диску:  ${reused}`);
  console.log(`  немає в Binotel:    ${unavailable}`);
  console.log(`  помилки (повторити): ${failed}`);
  console.log(`  цей прогін:         ${fmtMb(bytes)}`);
  console.log(`  архів усього:       ${after.stored} записів, ${fmtMb(Number(after.bytes))}`);
  console.log(`  лишилось не пробуваних: ${after.untried}`);
  if (failures.length) {
    console.log('\n[backfillAudio] дзвінки без архіву:');
    for (const f of failures.slice(0, 50)) console.log(`  ${f.id}: ${f.reason}`);
    if (failures.length > 50) console.log(`  … і ще ${failures.length - 50}`);
  }

  if (failed > 0) {
    console.error(`\n[backfillAudio] прогін НЕПОВНИЙ: ${failed} помилок — запустіть команду ще раз, вона продовжить з того ж місця.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[backfillAudio] fatal: ${err.message}`);
  process.exit(1);
});
