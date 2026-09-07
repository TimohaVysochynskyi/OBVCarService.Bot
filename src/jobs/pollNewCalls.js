import { getCheckpoint, setCheckpoint, getAudioArchiveStats, deleteOldErrorLog } from '../core/store.js';
import { checkBotAlive } from '../core/liveness.js';
import { getElevenLabsBalance } from '../core/elevenlabs.js';
import { freeSpaceMb, storageRoot } from '../core/audioStore.js';
import { describeError, appError } from '../core/errors.js';
import { NOTICES } from '../core/errorTexts.js';
import { alertOnce, alertText } from '../core/alerts.js';
import { processCallsForRange, retryPendingCalls } from './processCalls.js';

// Watchdogs of the ingest. All three go through the SAME dedup (jobs/alerts.js: alertOnce): one
// alert when the problem appears, an optional reminder while it lasts, and one notice when it
// clears. Wording lives in core/errorTexts.js. None of them may ever break the poll itself.

// Low ElevenLabs balance. Credits → approx USD via a configurable rate (the API reports credits,
// not dollars). Also warns ONCE about a missing `user_read` permission, which is a config problem
// rather than a state - hence its own key, so it can't silence the balance alert or vice versa.
async function checkElevenLabsBalance() {
  if (!process.env.ELEVENLABS_API_KEY) return;
  const balance = await getElevenLabsBalance();

  await alertOnce('elevenlabs_permission', {
    active: !balance.ok && balance.reason === 'missing_permission',
    message: () => alertText(describeError(appError('ELV-PERM'), { action: 'ingest', icon: '⚠️' })),
  });

  // Everything except a permission problem stays quiet: a transient error says nothing about the
  // balance, and treating it as "low" would fire a false alarm.
  if (!balance.ok) return;

  const usdPer1000 = Number(process.env.ELEVENLABS_USD_PER_1000_CREDITS || 0.22);
  const minUsd = Number(process.env.ELEVENLABS_MIN_BALANCE_USD || 2);
  const remainingUsd = (balance.remainingCredits / 1000) * usdPer1000;

  await alertOnce('elevenlabs_balance_state', {
    active: remainingUsd < minUsd,
    message: () =>
      NOTICES.elevenLabsLow(remainingUsd.toFixed(2), balance.remainingCredits, balance.limit),
    recovered: () => NOTICES.elevenLabsRefilled(remainingUsd.toFixed(2)),
  });
}

// Free disk space on the volume that holds the audio archive. Recordings are kept indefinitely
// (client requirement), so space only ever goes one way - the alert is a heads-up, not an incident.
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

// Binotel outage. Unlike the two above, this one reports something nobody here can fix: on
// 2026-09-06 api.binotel.com answered EVERY request - any method, any credentials, from several
// networks - with HTTP 200 + "Something went wrong (exception)" for hours, and ingestion simply
// stops until Binotel is back. Alerting on each 15-minute run buried the owner in identical
// messages; staying silent would hide a multi-day gap. Hence: one alert, a reminder every
// BINOTEL_OUTAGE_REMINDER_MIN, and one notice on recovery.
const DEFAULT_REMINDER_MIN = 120;

function outageReminderMin() {
  const minutes = Number(process.env.BINOTEL_OUTAGE_REMINDER_MIN || DEFAULT_REMINDER_MIN);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_REMINDER_MIN;
}

// Returns true when an alert was actually sent, so jobs/index.js knows not to add its generic
// "джоба впала" on top of it.
async function noteBinotelDown(err) {
  return alertOnce('binotel_outage', {
    active: true,
    reminderMin: outageReminderMin(),
    // The first alert states the problem; a reminder leads with how long it has been going on.
    // Both go through describeError, so the "what to do / are we losing data" part is identical -
    // hours later that is exactly what the reader needs repeated.
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

// Чистка журналу інцидентів. Робить полер, бо він і так прокидається щочверть години, а журнал
// потрібен для розбору «що було вчора», не «що було пів року тому».
async function pruneErrorLog() {
  const keepDays = Number(process.env.ERROR_LOG_KEEP_DAYS || 30);
  const removed = await deleteOldErrorLog(new Date(Date.now() - keepDays * 24 * 3600 * 1000));
  if (removed) console.log(`[poll] прибрано зі журналу інцидентів: ${removed}`);
}

// Uses a persisted checkpoint instead of a fixed "last N minutes" window, so a delayed or
// skipped cron run never creates a gap - the next run just picks up exactly where the last
// one left off. Falls back to POLL_WINDOW_MINUTES only on the very first run ever.
async function pollNewCalls() {
  try {
    await retryPendingCalls();

    const end = new Date();
    const checkpoint = await getCheckpoint();
    const windowMinutes = Number(process.env.POLL_WINDOW_MINUTES || 20);
    const start = checkpoint || new Date(end.getTime() - windowMinutes * 60 * 1000);

    console.log(`[poll] checkpoint: ${checkpoint ? checkpoint.toISOString() : '(none, using default window)'}`);
    await processCallsForRange(start, end);
    await setCheckpoint(end);
    // A completed pass is the only proof Binotel is actually answering again.
    await noteBinotelUp().catch((e) => console.error(`[poll] recovery notice failed: ${e.message}`));
  } catch (err) {
    if (err?.binotelUnavailable) {
      const sent = await noteBinotelDown(err).catch((e) => {
        console.error(`[poll] outage alert failed: ${e.message}`);
        return false;
      });
      // Even inside the quiet window the failure counts as reported: the point of the dedup is
      // that jobs/index.js must NOT fall back to its generic alert every 15 minutes.
      err.alertSent = true;
      if (sent) console.log('[poll] outage alert sent');
    }
    throw err;
  }

  // Watchdogs — never let any of them break the poll.
  await checkElevenLabsBalance().catch((e) => console.error(`[poll] balance check failed: ${e.message}`));
  await checkAudioDiskSpace().catch((e) => console.error(`[poll] disk space check failed: ${e.message}`));
  // Наглядач за ботом живе ТУТ, бо полер і так бігає щочверть години — окремий таймер не потрібен.
  await checkBotAlive().catch((e) => console.error(`[poll] bot liveness check failed: ${e.message}`));
  await pruneErrorLog().catch((e) => console.error(`[poll] error log cleanup failed: ${e.message}`));
}

export { pollNewCalls };
