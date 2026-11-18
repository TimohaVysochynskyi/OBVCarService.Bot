import 'dotenv/config';
import { getCallsMissingComplaint, setClientComplaint } from '../features/analysis/repo.js';
import { migrate } from '../platform/db/pool.js';
import { detectClientComplaint } from '../features/analysis/clientComplaint.js';
import { complaintLabel } from '../domain/call/complaint.js';
import { displayName } from '../features/operators/display.js';
import { usageLine } from '../platform/openai/client.js';
import { config } from '../shared/config.js';


const LIMIT = process.argv.includes('--limit')
  ? Number(process.argv[process.argv.indexOf('--limit') + 1])
  : null;
const PAUSE_MS = config.backfill.complaintPauseMs;

async function main() {
  await migrate();

  const calls = await getCallsMissingComplaint(LIMIT ? { limit: LIMIT } : {});
  console.log(`[backfillComplaints] неперевірених дзвінків: ${calls.length} (найновіші першими)`);

  const byType = new Map();
  const byManager = new Map();
  let found = 0;
  let failed = 0;

  for (const [i, call] of calls.entries()) {
    try {
      const result = await detectClientComplaint(call.transcript, call.segments);
      await setClientComplaint(call.generalCallId, result);
      if (result.hasComplaint) {
        found += 1;
        byType.set(result.type, (byType.get(result.type) || 0) + 1);
        const who = call.managerName || '—';
        byManager.set(who, (byManager.get(who) || 0) + 1);
        console.log(
          `   ✓ ${call.generalCallId} (${displayName(who) ?? who}) — ${complaintLabel(result.type)}` +
            ` · «${result.quote.slice(0, 80)}»`
        );
      }
    } catch (err) {
      failed += 1;
      console.error(`   ✗ ${call.generalCallId}: ${err.message.slice(0, 160)}`);
    }
    if (PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS));
    if ((i + 1) % 100 === 0) console.log(`[backfillComplaints] … ${i + 1}/${calls.length}, знайдено ${found}`);
  }

  console.log('\n[backfillComplaints] --- РЕЗУЛЬТАТ ---');
  console.log(`  перевірено:            ${calls.length}`);
  console.log(`  незадоволень знайдено: ${found}`);
  console.log(`  не вдалося:            ${failed}`);
  console.log(`  вартість: ${usageLine()}`);

  if (byType.size) {
    console.log('\n[backfillComplaints] за типом:');
    for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${(complaintLabel(type) || type).padEnd(28)}${String(n).padStart(4)}`);
    }
    console.log('\n[backfillComplaints] по менеджерах:');
    for (const [who, n] of [...byManager].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${(displayName(who) ?? who).padEnd(14)}${String(n).padStart(4)}`);
    }
  }

  if (failed) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('[backfillComplaints] впав:', err);
    process.exit(1);
  });
