import 'dotenv/config';
import { migrate } from '../core/store.js';
import { pollNewCalls } from './pollNewCalls.js';
import { sendAlert } from '../core/telegram.js';
import { describeError } from '../core/errors.js';
import { alertOnce, alertText } from '../core/alerts.js';
import { recordError } from '../core/errorLog.js';
import { installProcessTraps } from '../core/processTraps.js';
import { markAlive } from '../core/liveness.js';

installProcessTraps('poll');

async function main() {
  const jobType = process.env.JOB_TYPE || 'poll';
  console.log(`[index] starting job: ${jobType}`);

  await migrate();
  await markAlive('poll');

  if (jobType === 'poll') {
    await pollNewCalls();
  } else {
    throw new Error(`Unknown JOB_TYPE "${jobType}" - only "poll" is supported`);
  }

  console.log(`[index] job finished`);
}

main().catch(async (err) => {
  const described = describeError(err, { action: 'ingest', icon: '⚠️' });
  console.error(`[index] ${described.code} інцидент ${described.incident}: ${described.technicalLine}`);
  console.error(err);
  await recordError(described, { source: 'poll', feature: 'ingest' });
  try {
    if (!err?.alertSent) {
      await alertOnce(`ingest_${described.code}`, {
        active: true,
        reminderMin: 120,
        message: () => alertText(described),
      });
    }
  } catch (alertErr) {
    console.error(`[index] не вдалося надіслати алерт: ${alertErr.message}`);
  }
  process.exit(1);
});
