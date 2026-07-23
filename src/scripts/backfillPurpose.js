import 'dotenv/config';
import { getCallsMissingPurpose, updateCallAnalysis } from '../core/store.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../core/analyzeCall.js';
import { displayName } from '../bot/operators.js';

// One-off, CHEAP backfill of call_purpose for historical calls ingested before the purpose field
// existed (call_purpose IS NULL). Re-runs ONLY the per-call MAP (analyzeCallBehaviors) over the
// ALREADY-STORED transcript — NO re-transcription, so no ElevenLabs cost (just one gpt-4o-mini call
// per row). This fixes the effectiveness metrics: a call with NULL purpose is treated as "sales" by
// SALES_FILTER, so routine info/other calls inflate the sales denominator (conversion) until their
// purpose is set. Existing segments are preserved (passed back unchanged, since updateCallAnalysis
// overwrites segments); rows without segments simply get behaviours without timecodes (no audio for
// them — same as before). Idempotent: only touches rows where call_purpose IS NULL.
//
// This is the lightweight sibling of backfill:analysis (which additionally re-transcribes via
// ElevenLabs to capture segments/timecodes for audio clips). Use this when you only need to fix the
// purpose/metrics for the whole history; use backfill:analysis when you also want audio evidence.
//
// Run on the VPS (needs DB + OPENAI_API_KEY):  npm run backfill:purpose

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
      // No re-STT: map over the stored transcript + existing segments. managerName is only prompt
      // context for role framing; displayName keeps aliases (e.g. Богдан) consistent with reports.
      const behaviors = await analyzeCallBehaviors(c.transcript, c.segments, displayName(c.managerName));
      await updateCallAnalysis(c.generalCallId, {
        transcript: null, // keep the stored transcript (COALESCE)
        segments: c.segments, // preserve existing timecodes — do NOT wipe them
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
