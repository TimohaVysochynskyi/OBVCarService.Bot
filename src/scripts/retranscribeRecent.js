import 'dotenv/config';
import { getOperators, getRecentCallsForOperator, updateCallTranscript } from '../core/store.js';
import { getRecordingForCall } from '../core/audioStore.js';
import { transcribeAudio } from '../core/transcribe.js';
import { displayName, hasAlias } from '../bot/operators.js';

const PER_OPERATOR = Number(process.env.RETRANSCRIBE_LIMIT || 5);

function isPersonOperator(name) {
  if (!name) return false;
  return !/^[0-9]+$/.test(name) || hasAlias(name);
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('[retranscribe] ELEVENLABS_API_KEY is not set — this script is meant to use ElevenLabs. Aborting.');
    process.exit(1);
  }

  const operators = (await getOperators()).filter((o) => isPersonOperator(o.name));
  if (operators.length === 0) {
    console.log('[retranscribe] no person operators found. Nothing to do.');
    process.exit(0);
  }
  console.log(`[retranscribe] operators: ${operators.map((o) => displayName(o.name)).join(', ')}`);
  console.log(`[retranscribe] last ${PER_OPERATOR} call(s) each, via ElevenLabs\n`);

  let ok = 0;
  let fail = 0;
  for (const op of operators) {
    const calls = await getRecentCallsForOperator(op.name, PER_OPERATOR);
    console.log(`[retranscribe] ${displayName(op.name)} — ${calls.length} call(s):`);
    for (const c of calls) {
      try {
        const audio = await getRecordingForCall(c.generalCallId);
        if (!audio) throw new Error('no recording (local or Binotel)');
        const { transcript } = await transcribeAudio(audio.buffer, {
          managerName: displayName(op.name),
          audioPath: audio.path,
        });
        await updateCallTranscript(c.generalCallId, transcript);
        console.log(`   ✓ ${c.generalCallId} (${c.startTime}) — ${transcript.length} chars`);
        ok += 1;
      } catch (err) {
        console.error(`   ✗ ${c.generalCallId}: ${err.message}`);
        fail += 1;
      }
    }
  }

  console.log(`\n[retranscribe] done: ${ok} updated, ${fail} failed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
