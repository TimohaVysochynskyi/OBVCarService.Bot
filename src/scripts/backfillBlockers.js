import 'dotenv/config';
import { migrate, getCallsMissingBlocker, setCallBlocker, getBlockerStats, clearAllReportSegments } from '../core/store.js';
import { detectDealBlocker, NO_BLOCKER } from '../core/dealBlocker.js';
import { displayName } from '../bot/operators.js';

// One-off (safely repeatable): decide "незакриті угоди" (src/core/dealBlocker.js) for the calls
// already in the DB, so the Черга/Профіль columns and the report block work over the whole history
// instead of starting from the day the feature shipped.
//
// Usage:
//   npm run backfill:blockers                 # every unchecked non-closed call, oldest first
//   npm run backfill:blockers -- --limit 20   # smoke test
//   npm run backfill:blockers -- --keep-cache # don't clear the cached report findings at the end
//
// Only calls that did NOT close are checked — a closed deal cannot have been blocked — which is what
// keeps a gpt-4o pass over the history cheap. Idempotent: a decided call (deal_blocker NOT NULL) is
// skipped, so an interrupted run costs nothing to repeat, and a call that errors keeps deal_blocker
// NULL so the next run retries it.
//
// PACING IS REQUIRED, not politeness: gpt-4o on this account is capped at 30k tokens/min, and each
// check is ~1.3k tokens (a confirmed candidate costs a second, verification call). Without a pause the
// run 429s within seconds.

const PAUSE_MS = Number(process.env.BACKFILL_BLOCKER_PAUSE_MS || 2600);

function parseArgs(argv) {
  const limitIdx = argv.indexOf('--limit');
  return {
    limit: limitIdx >= 0 ? Number(argv[limitIdx + 1]) : null,
    keepCache: argv.includes('--keep-cache'),
  };
}

async function main() {
  const { limit, keepCache } = parseArgs(process.argv.slice(2));
  await migrate();

  const before = await getBlockerStats();
  console.log(
    `[backfillBlockers] у БД ${before.total} дзвінків: без блокера ${before.clean}, черга ${before.noSlot}, профіль ${before.outOfScope}, ще не перевірено ${before.unchecked}`
  );

  const calls = await getCallsMissingBlocker({ limit });
  if (!calls.length) {
    console.log('[backfillBlockers] нічого перевіряти — усі незакриті дзвінки вже перевірені.');
    process.exit(0);
  }
  console.log(`[backfillBlockers] до перевірки: ${calls.length} дзвінк(ів), модель ${process.env.OPENAI_BLOCKER_MODEL || 'gpt-4o'}\n`);

  let clean = 0;
  let noSlot = 0;
  let outOfScope = 0;
  let failed = 0;

  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    const who = displayName(c.managerName) || c.managerName || '—';
    try {
      const r = await detectDealBlocker(c.transcript, c.segments, who);
      await setCallBlocker(c.generalCallId, { blocker: r.blocker, quote: r.quote });
      if (r.blocker === NO_BLOCKER) {
        clean += 1;
      } else {
        if (r.blocker === 'no_slot') noSlot += 1;
        else outOfScope += 1;
        console.log(
          `[backfillBlockers] ${i + 1}/${calls.length} ${c.generalCallId} (${who}, purpose=${c.callPurpose}) → ${r.blocker}\n    «${r.quote}»`
        );
      }
    } catch (err) {
      failed += 1;
      console.error(`[backfillBlockers] ${i + 1}/${calls.length} ${c.generalCallId} — ПОМИЛКА: ${err.message.slice(0, 160)}`);
    }
    if ((i + 1) % 50 === 0) console.log(`[backfillBlockers] … ${i + 1}/${calls.length} (черга ${noSlot}, профіль ${outOfScope})`);
    if (i < calls.length - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  const after = await getBlockerStats();
  console.log('\n[backfillBlockers] --- РЕЗУЛЬТАТ ---');
  console.log(`  перевірено:        ${clean + noSlot + outOfScope}`);
  console.log(`  без блокера:       ${clean}`);
  console.log(`  черга (СТО забите): ${noSlot}`);
  console.log(`  профіль (не наше):  ${outOfScope}`);
  console.log(`  помилки (повторити): ${failed}`);
  console.log(`  у БД тепер: черга ${after.noSlot}, профіль ${after.outOfScope}, не перевірено ${after.unchecked}`);

  // Cached report findings were produced when blocked calls still counted as ordinary failed deals;
  // clearing the cache makes the next report recompute with the blockers excluded. Skipped with
  // --keep-cache (e.g. on a --limit smoke run, where throwing the whole cache away would be wasteful).
  if (!keepCache && (noSlot || outOfScope)) {
    const n = await clearAllReportSegments();
    console.log(`  кеш звітів очищено: ${n} відрізок(ів) — findings перерахуються з урахуванням блокерів`);
  }

  if (failed > 0) {
    console.error(`\n[backfillBlockers] прогін НЕПОВНИЙ: ${failed} помилок — запустіть ще раз, він продовжить з того ж місця.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[backfillBlockers] fatal: ${err.message}`);
  process.exit(1);
});
