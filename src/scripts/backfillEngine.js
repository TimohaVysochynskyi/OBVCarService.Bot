import 'dotenv/config';
import { getCallsMissingEngine, setEngineRequest } from '../features/analysis/repo.js';
import { getEngineBreakdown } from '../features/reporting/repo.js';
import { migrate } from '../platform/db/pool.js';
import { detectEngineRequest } from '../features/analysis/engineRequest.js';
import { mentionsEngine, serviceLabel } from '../domain/call/engine.js';
import { usageLine } from '../platform/openai/client.js';
import { config } from '../shared/config.js';


const LIMIT = process.argv.includes('--limit')
  ? Number(process.argv[process.argv.indexOf('--limit') + 1])
  : null;
const PAUSE_MS = config.backfill.enginePauseMs;

async function main() {
  await migrate();

  const calls = await getCallsMissingEngine(LIMIT ? { limit: LIMIT } : {});
  const candidates = calls.filter((c) => mentionsEngine(c.transcript));
  console.log(
    `[backfillEngine] неперевірених дзвінків: ${calls.length}, з них згадують двигун: ${candidates.length}` +
      ` — решта позначається одразу, без запиту до моделі`
  );

  let asked = 0;
  let found = 0;
  let failed = 0;

  for (const [i, call] of calls.entries()) {
    try {
      const result = await detectEngineRequest(call.transcript);
      await setEngineRequest(call.generalCallId, result);
      if (result.isEngineRequest) {
        found += 1;
        console.log(
          `   ✓ ${call.generalCallId} (${call.managerName}) — ${serviceLabel(result.service)}` +
            `${result.car ? ` · ${result.car}` : ''}`
        );
      }
      if (mentionsEngine(call.transcript)) {
        asked += 1;
        if (PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS));
      }
    } catch (err) {
      failed += 1;
      console.error(`   ✗ ${call.generalCallId}: ${err.message.slice(0, 160)}`);
    }
    if ((i + 1) % 100 === 0) console.log(`[backfillEngine] … ${i + 1}/${calls.length}, знайдено ${found}`);
  }

  console.log('\n[backfillEngine] --- РЕЗУЛЬТАТ ---');
  console.log(`  перевірено:            ${calls.length}`);
  console.log(`  запитів до моделі:     ${asked}`);
  console.log(`  звернень по двигуну:   ${found}`);
  console.log(`  не вдалося:            ${failed}`);
  console.log(`  вартість: ${usageLine()}`);

  const breakdown = await getEngineBreakdown();
  if (breakdown.length) {
    console.log('\n[backfillEngine] по місяцях і послугах:');
    for (const row of breakdown) {
      console.log(`  ${row.month}  ${String(row.count).padStart(4)}  ${serviceLabel(row.service) || row.service}`);
    }
  }

  if (failed) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('[backfillEngine] впав:', err);
    process.exit(1);
  });
