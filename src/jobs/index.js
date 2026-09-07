import 'dotenv/config';
import { migrate } from '../core/store.js';
import { pollNewCalls } from './pollNewCalls.js';
import { sendAlert } from '../core/telegram.js';
import { describeError } from '../core/errors.js';
import { alertText } from './alerts.js';

async function main() {
  const jobType = process.env.JOB_TYPE || 'poll';
  console.log(`[index] starting job: ${jobType}`);

  await migrate();

  if (jobType === 'poll') {
    // The single deployed job: pull new calls from Binotel, transcribe, classify and store
    // them. Reporting/stats live in a separate bot project that reads the same database.
    await pollNewCalls();
  } else {
    throw new Error(`Unknown JOB_TYPE "${jobType}" - only "poll" is supported`);
  }

  console.log(`[index] job finished`);
}

main().catch(async (err) => {
  // Раніше тут у Telegram летів сирий текст винятку - саме це власник і отримував що 15 хвилин
  // під час аварії Binotel: з такого повідомлення не зрозуміти ні що зламалось, ні чи втрачені
  // дані, ні чи це взагалі його проблема. Тепер алерт збирається за шаблоном із errorTexts.js.
  const described = describeError(err, { action: 'ingest', icon: '⚠️' });
  console.error(`[index] ${described.code} інцидент ${described.incident}: ${described.technicalLine}`);
  console.error(err);
  try {
    // A Binotel outage is already reported (once, then on a reminder cadence) by the poller's
    // outage watchdog - re-alerting here would put the every-15-minutes spam straight back.
    if (!err?.alertSent) await sendAlert(alertText(described));
  } catch (alertErr) {
    console.error(`[index] не вдалося надіслати алерт: ${alertErr.message}`);
  }
  process.exit(1);
});
