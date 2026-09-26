import { insertErrorLog, getErrorLogByIncident } from './store.js';
import { appError, describeError } from './errors.js';


const SOURCES = new Set(['bot', 'poll']);

async function recordError(described, { source, feature = null, telegramId = null, context = null } = {}) {
  try {
    await insertErrorLog({
      incident: described.incident,
      code: described.code,
      process: SOURCES.has(source) ? source : 'bot',
      feature,
      telegramId,
      message: described.technicalLine,
      technical: described.technical,
      context,
    });
  } catch (err) {
    console.error(`[errorLog] інцидент ${described.incident} не записано: ${err.message}`);
  }
}

async function noteIssue(code, { source, feature = null, context = null, detail = null } = {}) {
  const described = describeError(appError(code, { message: detail || code }), { action: feature || 'fallback' });
  console.error(`[${source || 'bot'}] ${described.code} інцидент ${described.incident}: ${detail || '—'}`);
  await recordError(described, { source, feature, context });
  return described;
}

async function lookupIncident(incident) {
  try {
    return await getErrorLogByIncident(incident);
  } catch (err) {
    console.error(`[errorLog] інцидент ${incident} не прочитано: ${err.message}`);
    return null;
  }
}

export { recordError, noteIssue, lookupIncident };
