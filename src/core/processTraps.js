import { onPoolError } from './store.js';
import { describeError } from './errors.js';
import { recordError } from './errorLog.js';
import { sendAlert } from './telegram.js';
import { alertText } from './alerts.js';


const ALERT_DEADLINE_MS = 8000;

function installProcessTraps(source) {
  let dying = false;

  const die = async (kind, err) => {
    if (dying) return;
    dying = true;

    const described = describeError(err, { action: 'fallback', icon: '⚠️' });
    console.error(`[${source}] ${kind}: ${described.code} інцидент ${described.incident}`);
    console.error(err);

    const report = (async () => {
      await recordError(described, { source, feature: 'fallback', context: { kind } });
      await sendAlert(alertText(describeError(err, { action: 'fallback', icon: '⚠️', incident: described.incident })));
    })().catch((inner) => console.error(`[${source}] сповістити про ${kind} не вдалося: ${inner.message}`));

    await Promise.race([report, new Promise((resolve) => setTimeout(resolve, ALERT_DEADLINE_MS))]);
    process.exit(1);
  };

  process.on('unhandledRejection', (reason) => {
    die('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  process.on('uncaughtException', (err) => {
    die('uncaughtException', err);
  });

  onPoolError((err) => {
    die('poolError', err);
  });
}

export { installProcessTraps };
