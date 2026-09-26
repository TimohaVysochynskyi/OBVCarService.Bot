import 'dotenv/config';
import { getRecentCalls, updateCallAnalysis } from '../core/store.js';
import { getRecordingForCall } from '../core/audioStore.js';
import { transcribeDiarized } from '../core/elevenlabs.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../core/analyzeCall.js';
import { displayName } from '../bot/operators.js';

const LIMIT = Number(process.env.RETRANSCRIBE_LAST_LIMIT || 7);

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('[retranscribe:last] ELEVENLABS_API_KEY is not set — this script must use ElevenLabs. Aborting.');
    process.exit(1);
  }

  const calls = await getRecentCalls(LIMIT);
  if (calls.length === 0) {
    console.log('[retranscribe:last] no calls found. Nothing to do.');
    process.exit(0);
  }
  console.log(`[retranscribe:last] re-running the last ${calls.length} call(s) through ElevenLabs\n`);

  let ok = 0;
  let fail = 0;
  for (const c of calls) {
    const who = displayName(c.managerName) || c.managerName || c.internalNumber || '—';
    try {
      const audio = await getRecordingForCall(c.generalCallId);
      if (!audio) {
        console.warn(`   • ${c.generalCallId} (${who}) — no recording (local or Binotel), skip`);
        continue;
      }
      const blob = new Blob([audio.buffer], { type: 'audio/mpeg' });

      const { transcript, segments } = await transcribeDiarized(blob, who, { audioPath: audio.path });
      let behaviors = null;
      try {
        behaviors = await analyzeCallBehaviors(transcript, segments, who);
      } catch (err) {
        console.error(`   ! ${c.generalCallId} behavior analysis failed: ${err.message}`);
      }
      await updateCallAnalysis(c.generalCallId, {
        transcript,
        segments,
        behaviors,
        analysisVersion: behaviors ? ANALYSIS_VERSION : null,
        callPurpose: behaviors?.callPurpose ?? null,
      });
      console.log(
        `   ✓ ${c.generalCallId} (${who}) — ${segments?.length ?? 0} segments, ` +
        `purpose=${behaviors?.callPurpose ?? '—'}, ${behaviors?.items?.length ?? 0} behaviors`
      );
      ok += 1;
    } catch (err) {
      console.error(`   ✗ ${c.generalCallId} (${who}): ${err.message}`);
      fail += 1;
    }
  }

  console.log(`\n[retranscribe:last] done: ${ok} re-transcribed, ${fail} failed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
