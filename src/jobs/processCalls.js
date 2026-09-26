import { callExists, saveCall, upsertPending, markPendingFailed, removePendingCall, getPendingCalls, getOperatorRoster } from '../core/store.js';
import { SHARED_EXTENSIONS, PERSONAL_OPERATORS, EXCLUDED_EXTENSIONS } from '../core/phoneLines.js';
import { listCallsForPeriod } from '../core/binotel.js';
import { storeRecording } from '../core/audioStore.js';
import { transcribeAudio } from '../core/transcribe.js';
import { classifyCall } from '../core/classifyCall.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../core/analyzeCall.js';
import { detectDealBlocker, NO_BLOCKER } from '../core/dealBlocker.js';
import { identifyManager } from '../core/identifyManager.js';
import { sendAlert } from '../core/telegram.js';
import { appError, classify, describeError, isHopeless, reviveError } from '../core/errors.js';
import { NOTICES } from '../core/errorTexts.js';
import { alertText } from '../core/alerts.js';
import { recordError } from '../core/errorLog.js';

const MAX_CHUNK_MS = 23 * 60 * 60 * 1000;
const MAX_PENDING_ATTEMPTS = Number(process.env.MAX_PENDING_ATTEMPTS || 20);

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

async function transcribeClassifyAndSave(call, roster) {
  const audio = await storeRecording(call.generalCallId, call.startTime);
  if (!audio.buffer) throw appError('SYS-NOFILE', { message: audio.error || 'Binotel не віддав запис' });
  console.log(
    `[processCalls]   audio ${audio.reused ? 'reused' : 'stored'}: ${audio.relPath ?? '(не збережено)'} (${audio.bytes} B)`
  );

  const { transcript, segments } = await transcribeAudio(audio.buffer, {
    managerName: call.employeeName,
    audioPath: audio.path,
  });
  const managerName = await resolveManagerName(call, transcript, roster);

  let behaviors = null;
  try {
    behaviors = await analyzeCallBehaviors(transcript, segments, managerName);
  } catch (err) {
    console.error(`[processCalls]   behavior analysis failed for ${call.generalCallId}: ${err.message}`);
  }

  const purpose = behaviors?.callPurpose ?? null;
  const isSalesCall = purpose === null || purpose === 'sales';
  let classification = { isSuccess: null, weakestStage: null, communicationScore: null };
  if (isSalesCall) {
    classification = await classifyCall(transcript, segments);
  } else {
    console.log(`[processCalls]   ${call.generalCallId} purpose=${purpose} → non-sales, skipping effectiveness scoring`);
  }

  let blocker = { blocker: NO_BLOCKER, quote: null };
  if (classification.isSuccess !== true) {
    try {
      blocker = await detectDealBlocker(transcript, segments, managerName);
      if (blocker.unchecked) blocker = { blocker: null, quote: null };
      else if (blocker.blocker !== NO_BLOCKER) {
        console.log(`[processCalls]   ${call.generalCallId} deal blocker: ${blocker.blocker} — «${blocker.quote?.slice(0, 70)}»`);
      }
    } catch (err) {
      console.error(`[processCalls]   deal-blocker check failed for ${call.generalCallId}: ${err.message}`);
      blocker = { blocker: null, quote: null };
    }
  }

  await saveCall({
    generalCallId: call.generalCallId,
    direction: call.direction ?? null,
    internalNumber: call.internalNumber,
    managerName,
    startTime: call.startTime,
    durationSec: call.durationSec,
    clientNumber: call.clientNumber,
    clientName: call.clientName,
    hangupBy: call.hangupBy,
    transcript,
    segments,
    behaviors,
    analysisVersion: behaviors ? ANALYSIS_VERSION : null,
    callPurpose: behaviors?.callPurpose ?? null,
    introName: behaviors?.intro ? behaviors.intro.name : null,
    introCompany: behaviors?.intro ? behaviors.intro.company : null,
    isSuccess: classification.isSuccess,
    weakestStage: classification.weakestStage,
    communicationScore: classification.communicationScore,
    dealBlocker: classification.isSuccess === true ? NO_BLOCKER : blocker.blocker,
    dealBlockerQuote: blocker.quote,
    audioPath: audio.relPath,
    audioBytes: audio.relPath ? audio.bytes : null,
    audioStatus: audio.relPath ? 'stored' : null,
  });
}

async function archiveExcludedAudio(call) {
  try {
    const audio = await storeRecording(call.generalCallId, call.startTime);
    if (!audio.relPath) {
      console.warn(`[processCalls]   excluded ${call.generalCallId}: audio not archived (${audio.error || 'невідома причина'})`);
      return;
    }
    console.log(`[processCalls]   excluded ${call.generalCallId}: audio ${audio.reused ? 'reused' : 'archived'} at ${audio.relPath}`);
  } catch (err) {
    console.error(`[processCalls]   excluded ${call.generalCallId}: audio archiving failed: ${err.message}`);
  }
}

async function processOneCall(call, roster) {
  const pendingLabel = call.employeeName || String(call.internalNumber);
  const excluded = EXCLUDED_EXTENSIONS.includes(String(call.internalNumber));

  if (excluded && call.durationSec > 0 && call.recordingStatus !== 'uploaded') {
    console.log(`[processCalls]   ${call.generalCallId} (excluded) recording not ready (${call.recordingStatus}) - queued for audio archiving`);
    await upsertPending({ ...call, managerName: pendingLabel }, `excluded ext, recording status: ${call.recordingStatus}`);
    return;
  }

  if (excluded) {
    console.log(`[processCalls]   skipping ${call.generalCallId} - extension ${call.internalNumber} is excluded from ingestion (audio only)`);
    if (call.durationSec > 0) await archiveExcludedAudio(call);
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

const DEFAULT_CHUNK_PAUSE_MS = 1500;

function chunkPauseMs() {
  const ms = Number(process.env.POLL_CHUNK_PAUSE_MS || DEFAULT_CHUNK_PAUSE_MS);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_CHUNK_PAUSE_MS;
}

async function processCallsForRange(start, end) {
  const roster = await getOperatorRoster();
  const chunks = splitIntoChunks(start, end);
  console.log(`[processCalls] range ${start.toISOString()} -> ${end.toISOString()}, ${chunks.length} chunk(s), roster: ${roster.join(', ') || '(empty)'}`);
  for (let i = 0; i < chunks.length; i += 1) {
    const [chunkStart, chunkEnd] = chunks[i];
    await processChunk(chunkStart, chunkEnd, roster);
    if (i < chunks.length - 1) await new Promise((resolve) => setTimeout(resolve, chunkPauseMs()));
  }
}

async function alertCallDropped(call, err, { title }) {
  const described = describeError(err, {
    title,
    icon: '⚠️',
    advice: NOTICES.callDroppedAdvice,
    data: NOTICES.callGaveUpData,
  });
  console.error(
    `[processCalls] ${described.code} інцидент ${described.incident}: ${described.technicalLine}`
  );
  await recordError(described, {
    source: 'poll',
    feature: 'ingest',
    context: { generalCallId: call.generalCallId, manager: call.managerName, attempts: call.attempts },
  });
  await sendAlert(alertText(described)).catch((e) =>
    console.error(`[processCalls] не вдалося надіслати алерт: ${e.message}`)
  );
}

async function retryPendingCalls() {
  const pending = await getPendingCalls();
  if (pending.length === 0) return;

  const roster = await getOperatorRoster();
  console.log(`[processCalls] retrying ${pending.length} pending call(s)`);
  for (const call of pending) {
    if (EXCLUDED_EXTENSIONS.includes(String(call.internalNumber))) {
      console.log(`[processCalls]   pending ${call.generalCallId} - extension ${call.internalNumber} is excluded from ingestion (audio only)`);
      if (call.durationSec > 0) await archiveExcludedAudio(call);
      await removePendingCall(call.generalCallId);
      continue;
    }

    if (call.attempts >= MAX_PENDING_ATTEMPTS) {
      console.error(`[processCalls] giving up on ${call.generalCallId} after ${call.attempts} attempts`);
      await markPendingFailed(call.generalCallId);
      await alertCallDropped(call, reviveError(call.lastError), {
        title: NOTICES.callGaveUp(call.generalCallId, call.managerName, call.attempts),
      });
      continue;
    }

    try {
      console.log(`[processCalls]   retrying ${call.generalCallId} (attempt ${call.attempts + 1})...`);
      await transcribeClassifyAndSave(call, roster);
      console.log(`[processCalls]   pending call recovered: ${call.generalCallId}`);
    } catch (err) {
      if (err?.binotelUnavailable) {
        console.error(`[processCalls]   aborting pending retries - Binotel is unavailable: ${err.message}`);
        throw err;
      }
      const code = classify(err);
      if (isHopeless(code)) {
        console.error(`[processCalls]   ${call.generalCallId} is hopeless (${code}): ${err.message}`);
        await markPendingFailed(call.generalCallId);
        await alertCallDropped(call, err, {
          title: NOTICES.callHopeless(call.generalCallId, call.managerName),
        });
        continue;
      }
      console.error(`[processCalls]   pending retry failed for ${call.generalCallId}: ${err.message}`);
      await upsertPending(call, err.message);
    }
  }
}

export { processCallsForRange, retryPendingCalls };
