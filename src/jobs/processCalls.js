import { callExists, saveCall, upsertPending, markPendingFailed, removePendingCall, getPendingCalls, getOperatorRoster } from '../core/store.js';
import { listCallsForPeriod, getCallRecordUrl } from '../core/binotel.js';
import { transcribeAudio } from '../core/transcribe.js';
import { classifyCall } from '../core/classifyCall.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../core/analyzeCall.js';
import { identifyManager } from '../core/identifyManager.js';
import { sendAlert } from '../core/telegram.js';

const MAX_CHUNK_MS = 23 * 60 * 60 * 1000; // stay safely under Binotel's 24h cap on this endpoint
const MAX_PENDING_ATTEMPTS = Number(process.env.MAX_PENDING_ATTEMPTS || 20);

// Extensions that are physically shared between operators (a common handset), where Binotel
// can't tell us who actually answered. For these the operator is identified from the recording
// (see identifyManager). Personal extensions carry a name from Binotel directly.
const SHARED_EXTENSIONS = (process.env.SHARED_EXTENSIONS || '901,902')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Personal extensions are identified by NUMBER, not by whatever name Binotel's employeeData
// currently reports for them. Binotel's employeeData.name has been observed to (a) go briefly
// empty for a personal extension (which used to fall through to content-based identification and
// sometimes misattribute the call to a DIFFERENT manager), and (b) change spelling (e.g. a RU->UK
// rename in the Binotel dashboard), which would otherwise split one person's history into two
// manager_name buckets. The extension number is the stable identifier Binotel gives us, so it's
// the source of truth for which of OUR canonical names a personal-extension call belongs to;
// employeeName/identifyManager are never consulted for these extensions once mapped here.
// Format: "ext=Name,ext=Name" via env, merged over the default.
const DEFAULT_PERSONAL_OPERATORS = { '903': 'Роман', '904': 'Андрій', '905': 'Володимир' };
function parsePersonalOperators(raw) {
  const map = { ...DEFAULT_PERSONAL_OPERATORS };
  for (const pair of (raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key && val) map[key] = val;
  }
  return map;
}
const PERSONAL_OPERATORS = parsePersonalOperators(process.env.PERSONAL_OPERATORS);

// Extensions to skip entirely - never transcribed, analyzed or saved. For a number that isn't a
// salesperson's line (e.g. the director's personal mobile), Binotel carries no employeeData for
// it, so it used to fall through to content-based identification and could misattribute calls to
// a real manager by voice match alone, polluting their stats. Comma-separated via env, merged
// over the default (the director's mobile, ends in -200).
const EXCLUDED_EXTENSIONS = (process.env.EXCLUDED_EXTENSIONS || '0674738200')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function splitIntoChunks(start, end) {
  const chunks = [];
  let chunkStart = start;
  while (chunkStart < end) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + MAX_CHUNK_MS, end.getTime()));
    chunks.push([chunkStart, chunkEnd]);
    chunkStart = chunkEnd;
  }
  return chunks;
}

// Binotel is the source of truth for WHICH extension took the call, but not for spelling/name
// stability - see PERSONAL_OPERATORS above. A known personal extension (903/904/905) is resolved
// straight from that map, no matter what (or whether) Binotel's employeeData says, and never goes
// through content-based identification. Shared handsets (SHARED_EXTENSIONS) - and any OTHER
// extension Binotel doesn't carry a name for - fall back to asking the model who introduced
// themselves, constrained to the known operator names (roster, derived from Binotel names on
// other calls). No match / no name -> keep the bare extension as the label so the call still
// shows up, just unattributed to a person.
async function resolveManagerName(call, transcript, roster) {
  const ext = String(call.internalNumber);

  if (PERSONAL_OPERATORS[ext]) {
    return PERSONAL_OPERATORS[ext];
  }

  if (SHARED_EXTENSIONS.includes(ext) || !call.employeeName) {
    const identified = await identifyManager(transcript, roster);
    return identified || call.employeeName || ext;
  }

  return call.employeeName;
}

// Determines the call PURPOSE first, scores effectiveness ONLY for sales calls, resolves the
// operator name, and saves. Shared by the fresh-call path and the pending-retry path so all of
// this happens exactly once, right when the transcript first becomes available.
//
// Purpose-first is deliberate: a non-sales call (info/other — a routine "your car is ready", a
// booking confirmation, a status query) must not spend any resource on sales effectiveness
// evaluation. So the per-call MAP (which decides callPurpose) runs BEFORE classifyCall, and
// classifyCall runs only when the call is a sales call.
async function transcribeClassifyAndSave(call, roster) {
  const recordUrl = await getCallRecordUrl(call.generalCallId);
  // employeeName (Binotel, personal extensions) anchors speaker-role detection on our actual
  // employee. Null for shared handsets — role detection falls back to operator-role heuristics.
  // segments = timecoded diarized turns (null on the OpenAI fallback / single-speaker calls).
  const { transcript, segments } = await transcribeAudio(recordUrl, { managerName: call.employeeName });
  const managerName = await resolveManagerName(call, transcript, roster);

  // Per-call "map": decides callPurpose (sales/info/other) and, for sales calls, tags manager
  // behaviours + verbatim quotes (cached for the report reduce). Never fatal — if it fails we save
  // the call without behaviors (backfill later) and, since the purpose is then unknown, fall back
  // to treating it as a sales call below so a transient error never silently drops the scoring.
  let behaviors = null;
  try {
    behaviors = await analyzeCallBehaviors(transcript, segments, managerName);
  } catch (err) {
    console.error(`[processCalls]   behavior analysis failed for ${call.generalCallId}: ${err.message}`);
  }

  // Score success / weakest stage / communication ONLY for sales calls. Non-sales calls get NULL
  // classification and NO classifyCall request at all (zero resources spent evaluating them). A
  // null/unknown purpose (behaviors failed) is treated as sales so we don't lose scoring on errors.
  const purpose = behaviors?.callPurpose ?? null;
  const isSalesCall = purpose === null || purpose === 'sales';
  let classification = { isSuccess: null, weakestStage: null, communicationScore: null };
  if (isSalesCall) {
    classification = await classifyCall(transcript);
  } else {
    console.log(`[processCalls]   ${call.generalCallId} purpose=${purpose} → non-sales, skipping effectiveness scoring`);
  }

  await saveCall({
    generalCallId: call.generalCallId,
    internalNumber: call.internalNumber,
    managerName,
    startTime: call.startTime,
    durationSec: call.durationSec,
    transcript,
    segments,
    behaviors,
    analysisVersion: behaviors ? ANALYSIS_VERSION : null,
    callPurpose: behaviors?.callPurpose ?? null,
    isSuccess: classification.isSuccess,
    weakestStage: classification.weakestStage,
    communicationScore: classification.communicationScore,
  });
}

// One attempt at turning a discovered call into a saved transcript. Never throws - on failure
// it records the call in the pending queue (or bumps its attempt count) so a later poll run
// retries it, instead of silently losing it.
async function processOneCall(call, roster) {
  const pendingLabel = call.employeeName || String(call.internalNumber);

  if (EXCLUDED_EXTENSIONS.includes(String(call.internalNumber))) {
    console.log(`[processCalls]   skipping ${call.generalCallId} - extension ${call.internalNumber} is excluded from ingestion`);
    return;
  }

  if (call.durationSec <= 0) {
    console.log(`[processCalls]   skipping ${call.generalCallId} - no duration (missed/unanswered)`);
    return;
  }

  if (call.recordingStatus !== 'uploaded') {
    console.log(`[processCalls]   ${call.generalCallId} recording not ready yet (status: ${call.recordingStatus}) - queued for retry`);
    await upsertPending({ ...call, managerName: pendingLabel }, `recording status: ${call.recordingStatus}`);
    return;
  }

  try {
    console.log(`[processCalls]   processing ${call.generalCallId}...`);
    await transcribeClassifyAndSave(call, roster);
    console.log(`[processCalls]   done: ${call.generalCallId}`);
  } catch (err) {
    console.error(`[processCalls]   FAILED ${call.generalCallId}: ${err.message}`);
    await upsertPending({ ...call, managerName: pendingLabel }, err.message);
  }
}

async function processChunk(start, end, roster) {
  const calls = await listCallsForPeriod(start, end);
  console.log(`[processCalls] chunk ${start.toISOString()} -> ${end.toISOString()}: ${calls.length} call(s)`);

  for (const call of calls) {
    if (await callExists(call.generalCallId)) {
      console.log(`[processCalls]   skipping ${call.generalCallId} - already processed`);
      continue;
    }
    console.log(`[processCalls] call ${call.generalCallId} (ext ${call.internalNumber}, ${call.durationSec}s)`);
    await processOneCall(call, roster);
  }
}

async function processCallsForRange(start, end) {
  const roster = await getOperatorRoster();
  const chunks = splitIntoChunks(start, end);
  console.log(`[processCalls] range ${start.toISOString()} -> ${end.toISOString()}, ${chunks.length} chunk(s), roster: ${roster.join(', ') || '(empty)'}`);
  for (const [chunkStart, chunkEnd] of chunks) {
    await processChunk(chunkStart, chunkEnd, roster);
  }
}

// Retries everything still sitting in the pending queue before we look for brand-new calls.
// Gives up (and alerts) after MAX_PENDING_ATTEMPTS so a permanently broken recording doesn't
// retry forever.
async function retryPendingCalls() {
  const pending = await getPendingCalls();
  if (pending.length === 0) return;

  const roster = await getOperatorRoster();
  console.log(`[processCalls] retrying ${pending.length} pending call(s)`);
  for (const call of pending) {
    if (EXCLUDED_EXTENSIONS.includes(String(call.internalNumber))) {
      console.log(`[processCalls]   dropping pending ${call.generalCallId} - extension ${call.internalNumber} is excluded from ingestion`);
      await removePendingCall(call.generalCallId);
      continue;
    }

    if (call.attempts >= MAX_PENDING_ATTEMPTS) {
      console.error(`[processCalls] giving up on ${call.generalCallId} after ${call.attempts} attempts`);
      await markPendingFailed(call.generalCallId);
      await sendAlert(`Не вдалося обробити дзвінок ${call.generalCallId} (${call.managerName}) після ${call.attempts} спроб. Позначено як "failed", дані в pending_calls збережено для перевірки вручну.`).catch(
        (e) => console.error(`[processCalls] failed to send alert: ${e.message}`)
      );
      continue;
    }

    try {
      console.log(`[processCalls]   retrying ${call.generalCallId} (attempt ${call.attempts + 1})...`);
      await transcribeClassifyAndSave(call, roster);
      console.log(`[processCalls]   pending call recovered: ${call.generalCallId}`);
    } catch (err) {
      console.error(`[processCalls]   pending retry failed for ${call.generalCallId}: ${err.message}`);
      await upsertPending(call, err.message);
    }
  }
}

export { processCallsForRange, retryPendingCalls };
