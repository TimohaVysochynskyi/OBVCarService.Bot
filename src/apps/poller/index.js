import 'dotenv/config';
import { migrate } from '../../platform/db/pool.js';
import { pollNewCalls } from '../../features/ingest/poll.js';
import { sendAlert } from '../../features/ops/notify.js';
import { describeError } from '../../shared/errors.js';
import { alertOnce, alertText } from '../../features/ops/alerts.js';
import { recordError } from '../../features/ops/errorLog.js';
import { installProcessTraps } from '../../features/ops/processTraps.js';
import { markAlive } from '../../features/ops/liveness.js';
import { config, missingConfig, configIssues } from '../../shared/config.js';
import { NOTICES } from '../../shared/errorTexts.js';

installProcessTraps('poll');

const missing = missingConfig(['db', 'binotel', 'openai', 'elevenlabs']);
if (missing.length) {
  console.error(`[poll] ${NOTICES.missingEnv(missing)}`);
  process.exit(1);
}
for (const issue of configIssues()) console.warn(`[poll] налаштування: ${issue}`);

async function main() {
  const jobType = config.poll.jobType;
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
