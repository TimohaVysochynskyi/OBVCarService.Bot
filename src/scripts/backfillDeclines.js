import 'dotenv/config';
import { migrate, getUnexplainedDeclines, setClientDeclineReason, getDeclineReasonCounts } from '../core/store.js';
import { classifyClientDecline } from '../core/clientDecline.js';
import { reasonLabel } from '../core/declineReasons.js';

const PAUSE_MS = Number(process.env.BACKFILL_DECLINE_PAUSE_MS || 400);

function parseArgs(argv) {
  const limitIdx = argv.indexOf('--limit');
  return { limit: limitIdx >= 0 ? Number(argv[limitIdx + 1]) : null };
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  await migrate();

  const calls = await getUnexplainedDeclines({ limit });
  if (!calls.length) {
    console.log('[backfillDeclines] нема чого перевіряти');
    return;
  }

  console.log(`[backfillDeclines] до перевірки: ${calls.length} незакритих угод(и)`);

  const counts = new Map();
  let downgraded = 0;
  let failed = 0;

  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    try {
      const verdict = await classifyClientDecline(c.transcript);
      if (!verdict) {
        failed += 1;
      } else {
        await setClientDeclineReason(c.generalCallId, verdict.reason);
        counts.set(verdict.reason, (counts.get(verdict.reason) || 0) + 1);
        if (verdict.downgraded) downgraded += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`[backfillDeclines] ${i + 1}/${calls.length} ${c.generalCallId} — ПОМИЛКА: ${err.message.slice(0, 160)}`);
    }

    if ((i + 1) % 25 === 0) console.log(`[backfillDeclines] … ${i + 1}/${calls.length}`);
    if (i < calls.length - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  console.log('\n[backfillDeclines] --- РЕЗУЛЬТАТ ---');
  for (const [reason, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${reasonLabel(reason) || reason}`);
  }
  console.log(`  без доказу → «причина не прозвучала»: ${downgraded}`);
  console.log(`  помилки: ${failed}`);

  console.log('\n[backfillDeclines] --- УСІ ПРИЧИНИ В БАЗІ ---');
  for (const row of await getDeclineReasonCounts()) {
    const side = row.side === 'service' ? 'СТО    ' : 'клієнт ';
    console.log(`  ${String(row.count).padStart(4)}  ${side} ${reasonLabel(row.reason) || row.reason}`);
  }

  if (failed) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('[backfillDeclines] впав:', err);
    process.exit(1);
  });
