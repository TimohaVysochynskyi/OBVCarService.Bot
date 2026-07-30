import 'dotenv/config';
import { migrate, getSalesCallsWithSegments, updateCallScore } from '../core/store.js';
import { classifyCall } from '../core/classifyCall.js';

// One-off: re-run ONLY the communicationScore for sales calls that already have timecoded segments,
// so historical scores are judged by the same criteria as new ones.
//
// Why this is needed: dialogue mechanics (interruptions / response latency — core/dialogueMetrics.js)
// were added to the scoring rubric on 2026-07-28. Findings get them retroactively for free (they are
// detected in code at report time), but the per-call score is frozen at ingest. Left alone, old calls
// would keep pre-rubric scores while new ones get stricter ones — and the "Динаміка" screen would
// then show a fake decline caused purely by the criteria change, not by the manager.
//
// Deliberately surgical: updates ONLY communication_score. isSuccess / weakestStage are untouched,
// so conversion history and the weak-stage series stay exactly as they were.
// Idempotent in the sense that re-running just recomputes the same thing (LLM scores may wobble ±1).

async function main() {
  await migrate();
  const calls = await getSalesCallsWithSegments();
  if (!calls.length) {
    console.log('[rescore:sales] немає дзвінків-угод із segments — нічого робити');
    return true;
  }
  console.log(`[rescore:sales] дзвінків-угод до перерахунку: ${calls.length}`);

  let ok = 0;
  let changed = 0;
  let failed = 0;
  const deltas = [];
  for (const c of calls) {
    try {
      const { communicationScore } = await classifyCall(c.transcript, c.segments);
      if (!Number.isInteger(communicationScore)) throw new Error('модель не повернула бал');
      const before = c.communicationScore;
      await updateCallScore(c.generalCallId, communicationScore);
      ok += 1;
      if (before !== communicationScore) {
        changed += 1;
        if (before != null) deltas.push(communicationScore - before);
      }
      console.log(`[rescore:sales]   ${c.generalCallId} (${c.managerName}): ${before ?? '—'} → ${communicationScore}`);
    } catch (err) {
      failed += 1;
      console.error(`[rescore:sales]   ${c.generalCallId} ПОМИЛКА: ${err.message}`);
    }
  }
  const avgDelta = deltas.length ? (deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2) : '0';
  console.log(
    `\n[rescore:sales] готово: ${ok}/${calls.length} перераховано, ${changed} змінили бал ` +
      `(середня зміна ${avgDelta}), ${failed} з помилкою`
  );
  return failed === 0;
}

main()
  .then((allOk) => process.exit(allOk ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
