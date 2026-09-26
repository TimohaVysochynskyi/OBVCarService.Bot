import 'dotenv/config';
import {
  migrate,
  getCallsMissingBlocker,
  setCallBlocker,
  getBlockerStats,
  resetAllBlockers,
  clearAllReportSegments,
} from '../core/store.js';
import { detectDealBlocker, NO_BLOCKER } from '../core/dealBlocker.js';
import { displayName } from '../bot/operators.js';


const PAUSE_MS = Number(process.env.BACKFILL_BLOCKER_PAUSE_MS || 2600);

function parseArgs(argv) {
  const limitIdx = argv.indexOf('--limit');
  return {
    limit: limitIdx >= 0 ? Number(argv[limitIdx + 1]) : null,
    keepCache: argv.includes('--keep-cache'),
    reset: argv.includes('--reset'),
    relabel: argv.includes('--relabel'),
  };
}

async function main() {
  const { limit, keepCache, reset, relabel } = parseArgs(process.argv.slice(2));
  await migrate();

  if (reset) {
    const n = await resetAllBlockers();
    console.log(`[backfillBlockers] --reset: скинуто ${n} раніше визначених дзвінків — усю історію буде перевірено за поточними правилами`);
  }

  const before = await getBlockerStats();
  console.log(
    `[backfillBlockers] у БД ${before.total} дзвінків: без блокера ${before.clean}, черга ${before.noSlot}, профіль ${before.outOfScope}, ще не перевірено ${before.unchecked}`
  );

  if (relabel) {
    console.log('[backfillBlockers] --relabel: перевіряються заново лише вже знайдені відмови, щоб отримати третю категорію і конкретну причину');
  }

  const calls = await getCallsMissingBlocker({ limit, relabel });
  if (!calls.length) {
    console.log('[backfillBlockers] нічого перевіряти — усі незакриті дзвінки вже перевірені.');
    process.exit(0);
  }
  console.log(`[backfillBlockers] до перевірки: ${calls.length} дзвінк(ів), модель ${process.env.OPENAI_BLOCKER_MODEL || 'gpt-4o'}\n`);

  let clean = 0;
  let noSlot = 0;
  let noParts = 0;
  let outOfScope = 0;
  let failed = 0;
  let unchecked = 0;

  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    const who = displayName(c.managerName) || c.managerName || '—';
    try {
      const r = await detectDealBlocker(c.transcript, c.segments, who);
      if (r.unchecked) {
        unchecked += 1;
        console.warn(`[backfillBlockers] ${i + 1}/${calls.length} ${c.generalCallId} — не перевірено (збій рецензента), лишається на потім`);
        if (i < calls.length - 1) await new Promise((r2) => setTimeout(r2, PAUSE_MS));
        continue;
      }
      await setCallBlocker(c.generalCallId, { blocker: r.blocker, quote: r.quote, reason: r.reason });
      if (r.blocker === NO_BLOCKER) {
        clean += 1;
      } else {
        if (r.blocker === 'no_slot') noSlot += 1;
        else if (r.blocker === 'no_parts') noParts += 1;
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
  console.log(`  нема деталей:       ${noParts}`);
  console.log(`  профіль (не наше):  ${outOfScope}`);
  console.log(`  помилки (повторити): ${failed}`);
  console.log(`  не перевірено (лишились NULL): ${unchecked}`);
  console.log(`  у БД тепер: черга ${after.noSlot}, профіль ${after.outOfScope}, не перевірено ${after.unchecked}`);

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
