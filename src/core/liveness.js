import { getHeartbeat, setHeartbeat } from './store.js';
import { alertOnce, humanDuration, kyivTime } from './alerts.js';
import { NOTICES } from './errorTexts.js';
import { config } from '../shared/config.js';


function startHeartbeat(name, intervalMs = 60_000) {
  const beat = () =>
    setHeartbeat(name).catch((err) => console.error(`[liveness] відмітка ${name} не пройшла: ${err.message}`));
  beat();
  return setInterval(beat, intervalMs);
}

async function markAlive(name) {
  await setHeartbeat(name).catch((err) =>
    console.error(`[liveness] відмітка ${name} не пройшла: ${err.message}`)
  );
}

async function checkAlive(name, { key, maxMinutes, message, recovered }) {
  const at = await getHeartbeat(name);
  if (!at) return false;
  const silentMs = Date.now() - at.getTime();
  return alertOnce(key, {
    active: silentMs > maxMinutes * 60_000,
    message: () => message(humanDuration(silentMs), kyivTime(at)),
    recovered: ({ downFor }) => recovered(downFor),
  });
}

async function checkBotAlive() {
  return checkAlive('bot', {
    key: 'bot_down',
    maxMinutes: config.liveness.botMaxMin,
    message: (silentFor) => NOTICES.botDown(silentFor),
    recovered: (downFor) => NOTICES.botRecovered(downFor),
  });
}

async function checkPollerAlive() {
  return checkAlive('poll', {
    key: 'poll_stale',
    maxMinutes: config.liveness.pollMaxMin,
    message: (silentFor, lastAt) => NOTICES.pollStale(silentFor, lastAt),
    recovered: (downFor) => NOTICES.pollRecovered(downFor),
  });
}

export { startHeartbeat, markAlive, checkBotAlive, checkPollerAlive };
