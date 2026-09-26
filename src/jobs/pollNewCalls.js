import { getCheckpoint, setCheckpoint, getAudioArchiveStats, deleteOldErrorLog } from '../core/store.js';
import { checkBotAlive } from '../core/liveness.js';
import { getElevenLabsBalance, creditsToUsd, minBalanceUsd } from '../core/elevenlabs.js';
import { freeSpaceMb, storageRoot } from '../core/audioStore.js';
import { describeError, appError } from '../core/errors.js';
import { NOTICES } from '../core/errorTexts.js';
import { sendAlert } from '../core/telegram.js';
import { alertOnce, alertText, resetIngestAlerts } from '../core/alerts.js';
import { processCallsForRange, retryPendingCalls } from './processCalls.js';


async function checkElevenLabsBalance() {
  if (!process.env.ELEVENLABS_API_KEY) return;
  const balance = await getElevenLabsBalance();

  await alertOnce('elevenlabs_permission', {
    active: !balance.ok && balance.reason === 'missing_permission',
    message: () => alertText(describeError(appError('ELV-PERM'), { action: 'ingest', icon: '⚠️' })),
  });

  if (!balance.ok) return;

  const remainingUsd = creditsToUsd(balance.remainingCredits);
  const minUsd = minBalanceUsd();

  await alertOnce('elevenlabs_balance_state', {
    active: remainingUsd < minUsd,
    message: () =>
      NOTICES.elevenLabsLow(remainingUsd.toFixed(2), balance.remainingCredits, balance.limit),
    recovered: () => NOTICES.elevenLabsRefilled(remainingUsd.toFixed(2)),
  });
}

async function checkAudioDiskSpace() {
  const freeMb = await freeSpaceMb();
  if (freeMb == null) return;

  const minFreeMb = Number(process.env.AUDIO_MIN_FREE_MB || 1024);
  const stats = freeMb < minFreeMb ? await getAudioArchiveStats().catch(() => null) : null;
  const archiveMb = stats ? Math.round(Number(stats.bytes) / (1024 * 1024)) : null;

  await alertOnce('audio_space_state', {
    active: freeMb < minFreeMb,
    message: () => NOTICES.diskLow(freeMb, minFreeMb, archiveMb, storageRoot()),
    recovered: () => NOTICES.diskFreed(freeMb),
  });
}

const DEFAULT_REMINDER_MIN = 120;

function outageReminderMin() {
  const minutes = Number(process.env.BINOTEL_OUTAGE_REMINDER_MIN || DEFAULT_REMINDER_MIN);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_REMINDER_MIN;
}

async function noteBinotelDown(err) {
  return alertOnce('binotel_outage', {
    active: true,
    reminderMin: outageReminderMin(),
    message: ({ first, downFor, since }) =>
      alertText(
        describeError(err, {
          action: 'ingest',
          icon: '⚠️',
          ...(first ? {} : { title: NOTICES.binotelStillDown(downFor, since) }),
        })
      ),
  });
}

async function noteBinotelUp() {
  return alertOnce('binotel_outage', {
    active: false,
    recovered: ({ downFor }) => NOTICES.binotelRecovered(downFor),
  });
}

async function pruneErrorLog() {
  const keepDays = Number(process.env.ERROR_LOG_KEEP_DAYS || 30);
  const removed = await deleteOldErrorLog(new Date(Date.now() - keepDays * 24 * 3600 * 1000));
  if (removed) console.log(`[poll] прибрано зі журналу інцидентів: ${removed}`);
}

async function clearIngestFailureAlerts() {
  const wasFailing = await resetIngestAlerts();
  if (wasFailing) await sendAlert(NOTICES.ingestRecovered, { icon: '✅' });
}

const DEFAULT_OVERLAP_MIN = 15;

function checkpointOverlapMs() {
  const minutes = Number(process.env.POLL_OVERLAP_MIN || DEFAULT_OVERLAP_MIN);
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_OVERLAP_MIN) * 60_000;
}

async function pollNewCalls() {
  try {
    await retryPendingCalls();

    const end = new Date();
    const checkpoint = await getCheckpoint();
    const windowMinutes = Number(process.env.POLL_WINDOW_MINUTES || 20);
    const start = checkpoint || new Date(end.getTime() - windowMinutes * 60 * 1000);

    console.log(`[poll] checkpoint: ${checkpoint ? checkpoint.toISOString() : '(none, using default window)'}`);
    await processCallsForRange(start, end);
    await setCheckpoint(new Date(end.getTime() - checkpointOverlapMs()));
    await noteBinotelUp().catch((e) => console.error(`[poll] recovery notice failed: ${e.message}`));
    await clearIngestFailureAlerts().catch((e) => console.error(`[poll] alert reset failed: ${e.message}`));
  } catch (err) {
    if (err?.binotelUnavailable) {
      const sent = await noteBinotelDown(err).catch((e) => {
        console.error(`[poll] outage alert failed: ${e.message}`);
        return false;
      });
      err.alertSent = true;
      if (sent) console.log('[poll] outage alert sent');
    }
    throw err;
  }

  await checkElevenLabsBalance().catch((e) => console.error(`[poll] balance check failed: ${e.message}`));
  await checkAudioDiskSpace().catch((e) => console.error(`[poll] disk space check failed: ${e.message}`));
  await checkBotAlive().catch((e) => console.error(`[poll] bot liveness check failed: ${e.message}`));
  await pruneErrorLog().catch((e) => console.error(`[poll] error log cleanup failed: ${e.message}`));
}

export { pollNewCalls };
