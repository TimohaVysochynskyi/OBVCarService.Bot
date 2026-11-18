import 'dotenv/config';
import { getCallsToRetranscribe, markSttMode, updateCallAnalysis } from '../features/analysis/repo.js';
import { migrate } from '../platform/db/pool.js';
import { getRecordingForCall } from '../platform/audio/store.js';
import { probeChannels } from '../platform/audio/meta.js';
import { transcribeDiarized, getElevenLabsBalance, creditsToUsd } from '../platform/elevenlabs/client.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../features/analysis/analyzeCall.js';
import { displayName } from '../features/operators/display.js';
import { usageLine } from '../platform/openai/client.js';
import { config } from '../shared/config.js';


const DEFAULT_RESERVE = 3000;
const BALANCE_EVERY = 25;
const CREDITS_PER_MIN = 20;

const creditsFor = (durationSec) => Math.ceil((Math.max(Number(durationSec) || 0, 30) / 60) * CREDITS_PER_MIN);

function flagValue(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
}

const LIMIT = flagValue('--limit') ? Number(flagValue('--limit')) : null;
const RESERVE = flagValue('--reserve') ? Number(flagValue('--reserve')) : DEFAULT_RESERVE;
const MAX_CREDITS = flagValue('--max-credits') ? Number(flagValue('--max-credits')) : null;
const PAUSE_MS = config.backfill.audioPauseMs;

async function remainingCredits() {
  const balance = await getElevenLabsBalance();
  return balance.ok ? balance.remainingCredits : null;
}

async function main() {
  await migrate();

  const startCredits = await remainingCredits();
  console.log(
    `[retranscribeCombined] кредитів на старті: ${startCredits ?? 'невідомо'}` +
      ` (~$${startCredits == null ? '—' : creditsToUsd(startCredits).toFixed(2)})` +
      ` · резерв ${RESERVE} — нижче цього прогін спиниться, щоб інжест не лишився без кредитів`
  );

  const calls = await getCallsToRetranscribe(LIMIT ? { limit: LIMIT } : {});
  console.log(`[retranscribeCombined] дзвінків без позначки режиму: ${calls.length} (найстаріші першими)`);

  let done = 0;
  let mono = 0;
  let noAudio = 0;
  let failed = 0;
  let credits = startCredits;
  let spent = 0;
  let stoppedOnReserve = false;

  for (const [i, call] of calls.entries()) {
    if (credits != null && credits <= RESERVE) {
      stoppedOnReserve = true;
      console.log(`\n[retranscribeCombined] залишок ${credits} кредитів досяг резерву ${RESERVE} — зупиняюсь на ${i} з ${calls.length}.`);
      break;
    }
    if (MAX_CREDITS != null && spent + creditsFor(call.durationSec) > MAX_CREDITS) {
      stoppedOnReserve = true;
      console.log(`\n[retranscribeCombined] межу ${MAX_CREDITS} кредитів вичерпано (витрачено ~${spent}) — зупиняюсь на ${i} з ${calls.length}.`);
      break;
    }

    const who = displayName(call.managerName) || call.managerName || '—';
    try {
      const audio = await getRecordingForCall(call.generalCallId);
      if (!audio) {
        noAudio += 1;
        continue;
      }

      const channels = await probeChannels(audio.path || null);
      if ((channels ?? 1) < 2) {
        await markSttMode(call.generalCallId, 'mono');
        mono += 1;
        continue;
      }

      const blob = new Blob([audio.buffer], { type: 'audio/mpeg' });
      const stt = await transcribeDiarized(blob, {
        managerName: who,
        audioPath: audio.path,
        direction: call.direction,
      });

      let behaviors = null;
      try {
        behaviors = await analyzeCallBehaviors(stt.transcript, stt.segments, who);
      } catch (err) {
        console.error(`   ! ${call.generalCallId} розбір не вдався: ${err.message.slice(0, 120)}`);
      }

      await updateCallAnalysis(call.generalCallId, {
        transcript: stt.transcript,
        segments: stt.segments,
        behaviors,
        analysisVersion: behaviors ? ANALYSIS_VERSION : null,
        callPurpose: behaviors?.callPurpose ?? null,
        sttMode: stt.sttMode,
      });
      done += 1;
      spent += creditsFor(call.durationSec);
      console.log(`   ✓ ${call.generalCallId} (${who}) — ${stt.segments?.length ?? 0} реплік, режим ${stt.sttMode}`);
    } catch (err) {
      if (err?.elevenlabsUnavailable) {
        console.error(`\n[retranscribeCombined] ПРОГІН ЗУПИНЕНО: ElevenLabs недоступний (${err.message}).`);
        console.error('[retranscribeCombined] Неперероблені лишились без позначки — повторний запуск продовжить звідти.');
        break;
      }
      failed += 1;
      console.error(`   ✗ ${call.generalCallId}: ${err.message.slice(0, 160)}`);
    }

    if (PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS));
    if ((i + 1) % BALANCE_EVERY === 0) {
      credits = await remainingCredits();
      console.log(`[retranscribeCombined] … ${i + 1}/${calls.length}, перероблено ${done}, кредитів ${credits ?? '—'}`);
    }
  }

  const endCredits = await remainingCredits();
  console.log('\n[retranscribeCombined] --- РЕЗУЛЬТАТ ---');
  console.log(`  перероблено:        ${done}`);
  console.log(`  моно, пропущено:    ${mono} (кредитів не витрачено)`);
  console.log(`  без запису:         ${noAudio}`);
  console.log(`  не вдалося:         ${failed}`);
  console.log(`  витрачено кредитів (оцінка): ~${spent}`);
  if (stoppedOnReserve) console.log('  зупинено за межею витрат; решта лишилась без позначки й чекає наступного заходу');
  if (startCredits != null && endCredits != null) {
    console.log(`  кредитів витрачено: ${startCredits - endCredits} (лишилось ${endCredits}, ~$${creditsToUsd(endCredits).toFixed(2)})`);
  }
  console.log(`  OpenAI за розбір:   ${usageLine()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[retranscribeCombined] впав:', err);
    process.exit(1);
  });
