import 'dotenv/config';
import { migrate, getNonSalesCalls, setCallPurpose } from '../core/store.js';
import { classifyNonSalesPurpose } from '../core/classifyPersonal.js';
import { displayName } from '../bot/operators.js';

const PAUSE_MS = Number(process.env.BACKFILL_PERSONAL_PAUSE_MS || 400);

function parseArgs(argv) {
  const limitIdx = argv.indexOf('--limit');
  return {
    limit: limitIdx >= 0 ? Number(argv[limitIdx + 1]) : null,
    reset: argv.includes('--reset'),
  };
}

async function main() {
  const { limit, reset } = parseArgs(process.argv.slice(2));
  await migrate();

  const calls = await getNonSalesCalls({ limit, onlyUnlabelled: !reset });
  if (!calls.length) {
    console.log('[backfillPersonal] нема чого перевіряти');
    return;
  }

  console.log(`[backfillPersonal] до перевірки: ${calls.length} дзвінк(ів)`);

  const moved = { personal: 0, info: 0, other: 0 };
  let unchanged = 0;
  let failed = 0;
  let downgraded = 0;

  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    try {
      const verdict = await classifyNonSalesPurpose(c.transcript);
      if (!verdict) {
        failed += 1;
      } else if (verdict.purpose === c.callPurpose) {
        unchanged += 1;
      } else {
        await setCallPurpose(c.generalCallId, verdict.purpose);
        moved[verdict.purpose] += 1;
        if (verdict.downgraded) downgraded += 1;
        if (verdict.purpose === 'personal') {
          const who = displayName(c.managerName) || c.managerName || '—';
          console.log(
            `[backfillPersonal] ${i + 1}/${calls.length} ${c.generalCallId} (${who}) ${c.callPurpose} → personal\n    «${verdict.evidence}»`
          );
        }
      }
    } catch (err) {
      failed += 1;
      console.error(`[backfillPersonal] ${i + 1}/${calls.length} ${c.generalCallId} — ПОМИЛКА: ${err.message.slice(0, 160)}`);
    }

    if ((i + 1) % 100 === 0) {
      console.log(`[backfillPersonal] … ${i + 1}/${calls.length} (особистих ${moved.personal})`);
    }
    if (i < calls.length - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  console.log('\n[backfillPersonal] --- РЕЗУЛЬТАТ ---');
  console.log(`  перевірено:      ${calls.length}`);
  console.log(`  → особисті:      ${moved.personal}`);
  console.log(`  → інформаційні:  ${moved.info}`);
  console.log(`  → службові:      ${moved.other}`);
  console.log(`  без змін:        ${unchanged}`);
  console.log(`  помилки:         ${failed}`);
  console.log(`  «особистий» без доказу (відкинуто): ${downgraded}`);

  if (failed) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('[backfillPersonal] впав:', err);
    process.exit(1);
  });
