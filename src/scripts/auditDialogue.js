import 'dotenv/config';
import { getCallsWithSegments } from '../features/analysis/repo.js';
import { migrate } from '../platform/db/pool.js';
import { displayName } from '../features/operators/display.js';
import {
  INTERRUPT_CUT_OFF,
  INTERRUPT_OVERLAP,
  detectInterruptions,
  detectLongPauses,
} from '../domain/call/dialogueMetrics.js';
import { config } from '../shared/config.js';


const PAUSE_REASONS = [
  'hold', 'warned_before', 'warned_after', 'client_asked_nothing', 'manager_said_nothing', 'same_exchange',
];

function pct(part, total) {
  return total ? `${((part / total) * 100).toFixed(1)}%` : '—';
}

function fragmentShare(segments) {
  const texts = segments.map((s) => String(s.text || '').trim());
  if (!texts.length) return 0;
  return texts.filter((t) => t.length < 6).length / texts.length;
}

async function main() {
  await migrate();

  const calls = await getCallsWithSegments();
  console.log(
    `[auditDialogue] дзвінків із таймкодами: ${calls.length}` +
      ` · поріг паузи ${config.call.longPauseSec}с · hold від ${config.call.holdSuspectSec}с` +
      ` · перекриття від ${config.call.interruptOverlapSec}с (без жодного звернення до API)`
  );

  const pauses = { total: 0, counted: 0 };
  const byReason = Object.fromEntries(PAUSE_REASONS.map((r) => [r, 0]));
  const interrupts = { total: 0, [INTERRUPT_OVERLAP]: 0, [INTERRUPT_CUT_OFF]: 0 };
  const callsWithPause = new Set();
  const callsWithInterrupt = new Set();
  const byManager = new Map();
  let fragments = 0;
  let fragmentedCalls = 0;
  let turns = 0;

  for (const call of calls) {
    const segments = call.segments || [];
    turns += segments.length;
    fragments += segments.filter((s) => String(s.text || '').trim().length < 6).length;
    if (fragmentShare(segments) > 0.3) fragmentedCalls += 1;

    const found = detectLongPauses(segments);
    const cut = detectInterruptions(segments);
    pauses.total += found.length;
    for (const p of found) {
      if (p.justified) byReason[p.reason] += 1;
      else {
        pauses.counted += 1;
        callsWithPause.add(call.generalCallId);
      }
    }
    interrupts.total += cut.length;
    for (const it of cut) interrupts[it.kind] += 1;
    if (cut.length) callsWithInterrupt.add(call.generalCallId);

    const key = call.managerName || '—';
    const acc = byManager.get(key) || { pauses: 0, interrupts: 0, calls: 0 };
    acc.calls += 1;
    acc.pauses += found.filter((p) => !p.justified).length;
    acc.interrupts += cut.length;
    byManager.set(key, acc);
  }

  console.log('\n[auditDialogue] --- ПАУЗИ ---');
  console.log(`  знайдено всього:     ${pauses.total}`);
  console.log(`  лишилось кандидатів: ${pauses.counted} на ${callsWithPause.size} дзвінк(ах)`);
  for (const reason of PAUSE_REASONS) {
    console.log(`  відсіяно «${reason}»: ${String(byReason[reason]).padStart(5)}`);
  }

  console.log('\n[auditDialogue] --- ПЕРЕБИВАННЯ ---');
  console.log(`  кандидатів:          ${interrupts.total} на ${callsWithInterrupt.size} дзвінк(ах)`);
  console.log(`  за перекриттям:      ${interrupts[INTERRUPT_OVERLAP]}`);
  console.log(`  за обривом на тире:  ${interrupts[INTERRUPT_CUT_OFF]}`);

  console.log('\n[auditDialogue] --- ЯКІСТЬ ТРАНСКРИПТІВ ---');
  console.log(`  реплік усього:            ${turns}`);
  console.log(`  коротших за 6 символів:   ${fragments} (${pct(fragments, turns)})`);
  console.log(`  дзвінків, де таких >30%:  ${fragmentedCalls} (${pct(fragmentedCalls, calls.length)})`);

  console.log('\n[auditDialogue] по менеджерах:');
  for (const [name, acc] of [...byManager].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(
      `  ${(displayName(name) ?? name).padEnd(14)} дзвінків ${String(acc.calls).padStart(5)}` +
        ` · пауз ${String(acc.pauses).padStart(4)} · перебивань ${String(acc.interrupts).padStart(4)}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[auditDialogue] впав:', err);
    process.exit(1);
  });
