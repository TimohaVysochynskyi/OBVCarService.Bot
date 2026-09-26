import 'dotenv/config';
import { getCallsMissingPurpose, updateCallAnalysis } from '../core/store.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../core/analyzeCall.js';
import { displayName } from '../bot/operators.js';


async function main() {
  const calls = await getCallsMissingPurpose();
  console.log(`[backfill:purpose] ${calls.length} call(s) with NULL purpose + transcript to process\n`);
  if (calls.length === 0) {
    console.log('[backfill:purpose] nothing to do.');
    process.exit(0);
  }

  let done = 0;
  let fail = 0;
  const dist = {};
  for (const c of calls) {
    try {
      const behaviors = await analyzeCallBehaviors(c.transcript, c.segments, displayName(c.managerName));
      await updateCallAnalysis(c.generalCallId, {
        transcript: null,
        segments: c.segments,
        behaviors,
        analysisVersion: ANALYSIS_VERSION,
        callPurpose: behaviors.callPurpose,
      });
      dist[behaviors.callPurpose] = (dist[behaviors.callPurpose] || 0) + 1;
      done += 1;
      if (done % 25 === 0) console.log(`   … ${done}/${calls.length} processed`);
    } catch (err) {
      console.error(`   ✗ ${c.generalCallId}: ${err.message}`);
      fail += 1;
    }
  }

  console.log(`\n[backfill:purpose] done: ${done} processed, ${fail} failed.`);
  console.log(`[backfill:purpose] purpose split: ${JSON.stringify(dist)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
