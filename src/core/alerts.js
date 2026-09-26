import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAlertState, setAlertState, clearAlertState, clearAlertStates } from './store.js';
import { sendAlert } from './telegram.js';
import { UI } from './errorTexts.js';


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

function alertText(described) {
  if (!described.technicalLine) return described.text;
  return `${described.text}\n${UI.technicalLine(described.technicalLine)}`;
}

const FALLBACK_FILE = join(tmpdir(), 'obv-alert-state.json');

function readFallback() {
  try {
    return JSON.parse(readFileSync(FALLBACK_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeFallback(all) {
  try {
    writeFileSync(FALLBACK_FILE, JSON.stringify(all));
  } catch (err) {
    console.error(`[alerts] резервний стан не записано: ${err.message}`);
  }
}

async function readState(key) {
  try {
    return await getAlertState(key);
  } catch (err) {
    console.error(`[alerts] стан із бази не прочитано (${key}): ${err.message}`);
    return readFallback()[key] ?? null;
  }
}

async function writeState(key, value) {
  try {
    await setAlertState(key, value);
  } catch {
    const all = readFallback();
    all[key] = value;
    writeFallback(all);
  }
}

async function dropState(key) {
  try {
    await dropState(key);
  } catch {
    const all = readFallback();
    delete all[key];
    writeFallback(all);
  }
}

async function resetIngestAlerts(prefix = 'ingest_') {
  let cleared = 0;
  try {
    cleared = await clearAlertStates(prefix);
  } catch (err) {
    console.error(`[alerts] стани не прибрано: ${err.message}`);
  }
  const all = readFallback();
  const stale = Object.keys(all).filter((key) => key.startsWith(prefix)).length;
  if (Object.keys(all).length) {
    try {
      rmSync(FALLBACK_FILE, { force: true });
    } catch {
    }
  }
  return cleared + stale > 0;
}

async function alertOnce(key, { active, message, recovered, reminderMin = 0 }) {
  const previous = await readState(key);
  const now = Date.now();

  if (!active) {
    if (!previous) return false;
    await clearAlertState(key);
    if (!recovered) return false;
    const sinceMs = Date.parse(previous.since);
    const downFor = Number.isFinite(sinceMs) ? humanDuration(now - sinceMs) : null;
    await sendAlert(recovered({ downFor }), { icon: '✅' });
    return true;
  }

  const stamp = new Date(now).toISOString();

  if (!previous) {
    await sendAlert(message({ first: true, downFor: null, since: null }));
    await writeState(key, { since: stamp, lastAlertAt: stamp });
    return true;
  }

  const sinceMs = Date.parse(previous.since);
  const sinceValid = Number.isFinite(sinceMs);
  const lastMs = Date.parse(previous.lastAlertAt || previous.since);
  const lastValid = Number.isFinite(lastMs);

  if (!reminderMin) return false;
  if (lastValid && now - lastMs < reminderMin * 60000) return false;

  await sendAlert(
    message({
      first: false,
      downFor: sinceValid ? humanDuration(now - sinceMs) : null,
      since: sinceValid ? kyivTime(new Date(sinceMs)) : null,
    })
  );
  await writeState(key, { since: sinceValid ? new Date(sinceMs).toISOString() : stamp, lastAlertAt: stamp });
  return true;
}

export { alertOnce, alertText, kyivTime, humanDuration, resetIngestAlerts };
