import 'dotenv/config';
import { getCallsMissingSegments, updateCallFullAnalysis } from '../features/analysis/repo.js';
import { getRecordingForCall } from '../platform/audio/store.js';
import { transcribeAudio } from '../features/analysis/transcribe.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../features/analysis/analyzeCall.js';
import { classifyCall } from '../features/analysis/classifyCall.js';
import { displayName } from '../features/operators/display.js';
import { config } from '../shared/config.js';

async function main() {
  if (!config.elevenlabs.apiKey) {
    console.error('[backfill] ELEVENLABS_API_KEY is not set — timecodes need ElevenLabs. Aborting.');
    process.exit(1);
  }

  const calls = await getCallsMissingSegments();
  console.log(`[backfill] ${calls.length} call(s) missing segments — re-transcribe + re-analyze (idempotent)\n`);
  if (calls.length === 0) {
    console.log('[backfill] nothing to do.');
    process.exit(0);
  }

  let done = 0;
  let skipped = 0;
  let fail = 0;
  for (const c of calls) {
    const name = displayName(c.managerName);
    try {
      const audio = await getRecordingForCall(c.generalCallId);
      if (!audio) {
        skipped += 1;
        console.warn(`   • ${c.generalCallId} (${name}) — no recording (local or Binotel), skip`);
        continue;
      }
      const { transcript, segments } = await transcribeAudio(audio.buffer, {
        managerName: name,
        audioPath: audio.path,
      });

      let behaviors = null;
      try {
        behaviors = await analyzeCallBehaviors(transcript, segments, name);
      } catch (err) {
        console.error(`   ! ${c.generalCallId} behavior analysis failed: ${err.message}`);
      }

      const purpose = behaviors?.callPurpose ?? null;
      const isSalesCall = purpose === null || purpose === 'sales';
      let classification = { isSuccess: null, weakestStage: null, communicationScore: null };
      if (isSalesCall) {
        classification = await classifyCall(transcript, segments);
      }

      await updateCallFullAnalysis(c.generalCallId, {
        transcript,
        segments,
        behaviors,
        analysisVersion: behaviors ? ANALYSIS_VERSION : null,
        callPurpose: behaviors?.callPurpose ?? null,
        isSuccess: classification.isSuccess,
        weakestStage: classification.weakestStage,
        communicationScore: classification.communicationScore,
      });
      const nItems = behaviors?.items?.length ?? 0;
      console.log(
        `   ✓ ${c.generalCallId} (${name}) — ${segments?.length ?? 0} segments, purpose=${behaviors?.callPurpose ?? '—'}, ${nItems} behaviors, score=${classification.communicationScore ?? '—'}`
      );
      done += 1;
    } catch (err) {
      console.error(`   ✗ ${c.generalCallId} (${name}): ${err.message}`);
      fail += 1;
    }
    if ((done + skipped + fail) % 25 === 0) {
      console.log(`   … ${done + skipped + fail}/${calls.length} attempted so far`);
    }
  }

  console.log(`\n[backfill] done: ${done} processed, ${skipped} skipped, ${fail} failed.`);
  process.exit(0);
}

main().catch((err) => {
  if (err?.elevenlabsUnavailable) {
    console.error(`\n[backfill] ПРОГІН ЗУПИНЕНО: ElevenLabs недоступний (${err.message}).`);
    console.error('[backfill] Дзвінки, яких не встигли обробити, лишились у борзі — запустіть скрипт знову, коли сервіс відновиться.');
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
