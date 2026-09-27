import { getAudioArchiveStats, getCheckpoint, setCheckpoint } from './repo.js';
import { deleteOldErrorLog } from '../ops/repo.js';
import { checkBotAlive } from '../ops/liveness.js';
import { getElevenLabsBalance, creditsToUsd, minBalanceUsd } from '../../platform/elevenlabs/client.js';
import { freeSpaceMb, storageRoot } from '../../platform/audio/store.js';
import { describeError, appError } from '../../shared/errors.js';
import { NOTICES } from '../../shared/errorTexts.js';
import { sendAlert } from '../ops/notify.js';
import { alertOnce, alertText, resetIngestAlerts } from '../ops/alerts.js';
import { processCallsForRange, retryPendingCalls } from './process.js';
import { config } from '../../shared/config.js';


async function checkElevenLabsBalance() {
  if (!config.elevenlabs.apiKey) return;
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

  const minFreeMb = config.audio.minFreeMb;
  const stats = freeMb < minFreeMb ? await getAudioArchiveStats().catch(() => null) : null;
  const archiveMb = stats ? Math.round(Number(stats.bytes) / (1024 * 1024)) : null;

  await alertOnce('audio_space_state', {
    active: freeMb < minFreeMb,
    message: () => NOTICES.diskLow(freeMb, minFreeMb, archiveMb, storageRoot()),
    recovered: () => NOTICES.diskFreed(freeMb),
  });
}

async function noteBinotelDown(err) {
  return alertOnce('binotel_outage', {
    active: true,
    reminderMin: config.binotel.outageReminderMin,
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

async function noteElevenLabsDown(err) {
  return alertOnce('elevenlabs_outage', {
    active: true,
    reminderMin: config.elevenlabs.outageReminderMin,
    message: ({ first, downFor, since }) =>
      alertText(
        describeError(err, {
          action: 'ingest',
          icon: '⚠️',
          title: first ? NOTICES.elevenLabsDown : NOTICES.elevenLabsStillDown(downFor, since),
          data: NOTICES.callsWaiting,
        })
      ),
  });
}

async function noteElevenLabsUp() {
  return alertOnce('elevenlabs_outage', {
    active: false,
    recovered: ({ downFor }) => NOTICES.elevenLabsBackUp(downFor),
  });
}

async function pruneErrorLog() {
  const keepDays = config.poll.errorLogKeepDays;
  const removed = await deleteOldErrorLog(new Date(Date.now() - keepDays * 24 * 3600 * 1000));
  if (removed) console.log(`[poll] прибрано зі журналу інцидентів: ${removed}`);
}

async function clearIngestFailureAlerts() {
  const wasFailing = await resetIngestAlerts();
  if (wasFailing) await sendAlert(NOTICES.ingestRecovered, { icon: '✅' });
}

function checkpointOverlapMs() {
  return config.poll.overlapMin * 60_000;
}

async function pollNewCalls() {
  try {
    await retryPendingCalls();

    const end = new Date();
    const checkpoint = await getCheckpoint();
    const windowMinutes = config.poll.windowMinutes;
    const start = checkpoint || new Date(end.getTime() - windowMinutes * 60 * 1000);

    console.log(`[poll] checkpoint: ${checkpoint ? checkpoint.toISOString() : '(none, using default window)'}`);
    await processCallsForRange(start, end);
    await setCheckpoint(new Date(end.getTime() - checkpointOverlapMs()));
    await noteBinotelUp().catch((e) => console.error(`[poll] recovery notice failed: ${e.message}`));
    await noteElevenLabsUp().catch((e) => console.error(`[poll] recovery notice failed: ${e.message}`));
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
    if (err?.elevenlabsUnavailable) {
      const sent = await noteElevenLabsDown(err).catch((e) => {
        console.error(`[poll] outage alert failed: ${e.message}`);
        return false;
      });
      err.alertSent = true;
      if (sent) console.log('[poll] ElevenLabs outage alert sent');
    }
    throw err;
  }

  await checkElevenLabsBalance().catch((e) => console.error(`[poll] balance check failed: ${e.message}`));
  await checkAudioDiskSpace().catch((e) => console.error(`[poll] disk space check failed: ${e.message}`));
  await checkBotAlive().catch((e) => console.error(`[poll] bot liveness check failed: ${e.message}`));
  await pruneErrorLog().catch((e) => console.error(`[poll] error log cleanup failed: ${e.message}`));
}

export { pollNewCalls };
