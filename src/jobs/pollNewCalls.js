import {
  getCheckpoint,
  setCheckpoint,
  getElevenLabsBalanceState,
  setElevenLabsBalanceState,
  getAudioSpaceState,
  setAudioSpaceState,
  getAudioArchiveStats,
  getBinotelOutage,
  setBinotelOutage,
  clearBinotelOutage,
} from '../core/store.js';
import { getElevenLabsBalance } from '../core/elevenlabs.js';
import { freeSpaceMb, storageRoot } from '../core/audioStore.js';
import { sendAlert } from '../core/telegram.js';
import { processCallsForRange, retryPendingCalls } from './processCalls.js';

// Low-balance watchdog for ElevenLabs. Runs each poll but alerts (to the same recipients as failure
// alerts, via sendAlert) only when the state CHANGES — so no spam. Credits → approx USD via a
// configurable rate (the API reports credits, not dollars). Never throws.
async function checkElevenLabsBalance() {
  if (!process.env.ELEVENLABS_API_KEY) return;
  const bal = await getElevenLabsBalance();
  const prev = await getElevenLabsBalanceState();

  if (!bal.ok) {
    // Only the (fixable) permission problem is worth a one-time heads-up; transient errors stay quiet.
    if (bal.reason === 'missing_permission' && prev !== 'no_permission') {
      await sendAlert(
        '⚠️ ElevenLabs: не можу перевіряти баланс — API-ключу бракує права «user_read». ' +
        'Додайте дозвіл user_read до ключа (ElevenLabs → Developers → API Keys), щоб отримувати сповіщення про низький баланс.'
      ).catch((e) => console.error(`[poll] balance alert failed: ${e.message}`));
      await setElevenLabsBalanceState('no_permission');
    }
    return;
  }

  const usdPer1000 = Number(process.env.ELEVENLABS_USD_PER_1000_CREDITS || 0.22);
  const minUsd = Number(process.env.ELEVENLABS_MIN_BALANCE_USD || 2);
  const remainingUsd = (bal.remainingCredits / 1000) * usdPer1000;
  const state = remainingUsd < minUsd ? 'low' : 'ok';

  if (state !== prev) {
    if (state === 'low') {
      await sendAlert(
        `⚠️ ElevenLabs: низький баланс — залишилося ~$${remainingUsd.toFixed(2)} ` +
        `(${bal.remainingCredits} кредитів із ${bal.limit}). Поповніть, інакше транскрипція ` +
        `перемкнеться на OpenAI (без діаризації, таймкодів і аудіо-доказів).`
      ).catch((e) => console.error(`[poll] balance alert failed: ${e.message}`));
    }
    await setElevenLabsBalanceState(state); // re-arms when balance recovers to 'ok'
  }
}

// Disk watchdog for the audio archive. Recordings are kept indefinitely (client requirement), so
// free space only ever goes one way. Same change-only alerting as the balance check: fires once when
// free space drops below AUDIO_MIN_FREE_MB and re-arms when space is freed. Never throws.
async function checkAudioDiskSpace() {
  const freeMb = await freeSpaceMb();
  if (freeMb == null) return;

  const minFreeMb = Number(process.env.AUDIO_MIN_FREE_MB || 1024);
  const state = freeMb < minFreeMb ? 'low' : 'ok';
  const prev = await getAudioSpaceState();
  if (state === prev) return;

  if (state === 'low') {
    const stats = await getAudioArchiveStats().catch(() => null);
    const archiveMb = stats ? Math.round(Number(stats.bytes) / (1024 * 1024)) : null;
    await sendAlert(
      `⚠️ Мало місця на диску: вільно ${freeMb} МБ (порог ${minFreeMb} МБ). ` +
      `Архів записів розмов — ${archiveMb == null ? 'невідомо' : archiveMb + ' МБ'} у ${storageRoot()}. ` +
      `Записи зберігаються назавжди, тому місце треба або розширити, або перенести старі записи.`
    ).catch((e) => console.error(`[poll] disk alert failed: ${e.message}`));
  }
  await setAudioSpaceState(state);
}

// Binotel outage watchdog. Unlike the two watchdogs above, this one alerts about something we
// cannot fix at all: on 2026-09-06 api.binotel.com answered EVERY request - any method, any
// credentials, from several networks - with HTTP 200 + "Something went wrong (exception)" for
// hours, so ingestion simply stops until Binotel is back. Alerting on each 15-minute poll run
// buried the owner in identical messages, but staying completely silent would hide a multi-day
// gap in ingestion. So: one alert when it first goes down, a reminder every
// BINOTEL_OUTAGE_REMINDER_MIN while it stays down, and one notice when it recovers. State lives
// in app_state.binotel_outage (see store.js), so it survives the cron process exiting each run -
// which is exactly why plain in-memory dedup wouldn't work here.
const DEFAULT_REMINDER_MIN = 120;

function reminderMs() {
  const min = Number(process.env.BINOTEL_OUTAGE_REMINDER_MIN || DEFAULT_REMINDER_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_REMINDER_MIN) * 60 * 1000;
}

// Kyiv wall-clock for humans. The ingest itself is UTC-only by design (the checkpoint is an
// absolute moment); this is purely how the alert text reads to the person getting it.
function kyivTime(date) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function humanDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours === 0) return `${minutes} хв`;
  return `${hours} год ${minutes} хв`;
}

async function noteBinotelDown(err) {
  const now = new Date();
  const previous = await getBinotelOutage();
  const checkpoint = await getCheckpoint().catch(() => null);
  const checkpointLine = checkpoint
    ? `Дані не втрачаються: чекпоінт стоїть на ${kyivTime(checkpoint)} і не рухається, тож після відновлення інжест сам догонить увесь пропущений період.`
    : 'Дані не втрачаються: чекпоінт не рухається, тож після відновлення інжест сам догонить пропущений період.';

  if (!previous) {
    await sendAlert(
      `Binotel API недоступний — збір дзвінків призупинено з ${kyivTime(now)}.\n\n` +
        `Відповідь Binotel: ${err.message}\n\n` +
        `${checkpointLine}\n` +
        `Це збій на боці Binotel, не в нашому коді. Наступне нагадування — через ${humanDuration(reminderMs())}, якщо не відновиться.`
    );
    await setBinotelOutage({ since: now.toISOString(), lastAlertAt: now.toISOString(), message: err.message });
    return;
  }

  const since = new Date(previous.since);
  const sinceValid = !Number.isNaN(since.getTime());
  const lastAlertAt = new Date(previous.lastAlertAt || previous.since);
  const lastAlertValid = !Number.isNaN(lastAlertAt.getTime());

  // Still inside the quiet window - stay silent, but keep the recorded cause current.
  if (lastAlertValid && now.getTime() - lastAlertAt.getTime() < reminderMs()) {
    await setBinotelOutage({ ...previous, message: err.message });
    return;
  }

  const downFor = sinceValid ? humanDuration(now.getTime() - since.getTime()) : 'невідомо скільки';
  await sendAlert(
    `Binotel API досі недоступний — уже ${downFor}${sinceValid ? ` (з ${kyivTime(since)})` : ''}. Збір дзвінків призупинено.\n\n` +
      `Відповідь Binotel: ${err.message}\n\n` +
      `${checkpointLine}\n` +
      'Якщо триває довго — варто написати в підтримку Binotel.'
  );
  await setBinotelOutage({
    since: sinceValid ? since.toISOString() : now.toISOString(),
    lastAlertAt: now.toISOString(),
    message: err.message,
  });
}

async function noteBinotelUp() {
  const previous = await getBinotelOutage();
  if (!previous) return; // nothing was broken - stay quiet

  await clearBinotelOutage();
  const since = new Date(previous.since);
  const downFor = Number.isNaN(since.getTime()) ? null : humanDuration(Date.now() - since.getTime());
  await sendAlert(
    `Binotel API відновився — збір дзвінків працює далі${downFor ? ` (простій ${downFor})` : ''}. ` +
      'Пропущені за цей час дзвінки обробляються з чекпоінта.',
    { icon: '✅' }
  );
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
      await noteBinotelDown(err).catch((e) => console.error(`[poll] outage alert failed: ${e.message}`));
      // Tells jobs/index.js the failure has already been reported, so it doesn't add the generic
      // "джоба впала" alert on top of it every single run.
      err.alertSent = true;
    }
    throw err;
  }

  // Watchdogs — never let either of them break the poll.
  await checkElevenLabsBalance().catch((e) => console.error(`[poll] balance check failed: ${e.message}`));
  await checkAudioDiskSpace().catch((e) => console.error(`[poll] disk space check failed: ${e.message}`));
}

export { pollNewCalls };
