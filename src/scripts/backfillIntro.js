import 'dotenv/config';
import { migrate, getCallsMissingIntro, updateCallIntro, getIntroBreakdown } from '../core/store.js';
import { detectIntro } from '../core/managerIntro.js';
import { PERSONAL_OPERATORS } from '../core/phoneLines.js';


const LIMIT = process.argv.includes('--limit')
  ? Number(process.argv[process.argv.indexOf('--limit') + 1])
  : null;

function pct(part, total) {
  return total ? `${Math.round((part / total) * 100)}%` : '—';
}

async function main() {
  await migrate();

  const calls = await getCallsMissingIntro(LIMIT ? { limit: LIMIT } : {});
  console.log(`[backfillIntro] дзвінків без позначки: ${calls.length} (без жодного звернення до OpenAI/ElevenLabs)`);

  let withName = 0;
  let withCompany = 0;
  for (const [i, call] of calls.entries()) {
    const intro = detectIntro({
      segments: call.segments,
      transcript: call.transcript,
      managerName: PERSONAL_OPERATORS[String(call.internalNumber)] || call.managerName,
    });
    await updateCallIntro(call.generalCallId, intro);
    if (intro.name) withName += 1;
    if (intro.company) withCompany += 1;
    if ((i + 1) % 200 === 0) console.log(`[backfillIntro] … ${i + 1}/${calls.length}`);
  }

  console.log('\n[backfillIntro] --- РЕЗУЛЬТАТ ---');
  console.log(`  оброблено:           ${calls.length}`);
  console.log(`  назвав своє імʼя:    ${withName} (${pct(withName, calls.length)})`);
  console.log(`  назвав сервіс:       ${withCompany} (${pct(withCompany, calls.length)})`);

  console.log('\n[backfillIntro] по менеджерах (лише персональні номери — там, де відсутність представлення є дефектом):');
  const byManager = new Map();
  for (const row of await getIntroBreakdown()) {
    const acc = byManager.get(row.manager) || { checked: 0, withName: 0, withCompany: 0 };
    acc.checked += row.checked;
    acc.withName += row.withName;
    acc.withCompany += row.withCompany;
    byManager.set(row.manager, acc);
  }
  for (const [manager, a] of [...byManager].sort((x, y) => y[1].checked - x[1].checked)) {
    console.log(
      `  ${manager.padEnd(12)} дзвінків ${String(a.checked).padStart(4)}` +
        ` · назвав імʼя ${String(a.withName).padStart(4)} (${pct(a.withName, a.checked)})` +
        ` · назвав сервіс ${String(a.withCompany).padStart(4)} (${pct(a.withCompany, a.checked)})`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfillIntro] впав:', err);
    process.exit(1);
  });
