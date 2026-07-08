const {
  getCheckpoint,
  setCheckpoint,
  getLastReportSlot,
  setLastReportSlot,
  getLastReportUntil,
  setLastReportUntil,
} = require('./store');
const { processCallsForRange, retryPendingCalls } = require('./processCalls');
const { generateDailyReport } = require('./generateReport');
const { kyivDateParts, kyivMidnightUtc } = require('./time');

const REPORT_HOURS = (process.env.REPORT_HOURS || String(process.env.REPORT_HOUR || 8))
  .split(',')
  .map((h) => Number(h.trim()));

// Uses a persisted checkpoint instead of a fixed "last N minutes" window, so a delayed or
// skipped cron run never creates a gap - the next run just picks up exactly where the last
// one left off. Falls back to POLL_WINDOW_MINUTES only on the very first run ever.
async function pollNewCalls() {
  await retryPendingCalls();

  const end = new Date();
  const checkpoint = await getCheckpoint();
  const windowMinutes = Number(process.env.POLL_WINDOW_MINUTES || 20);
  const start = checkpoint || new Date(end.getTime() - windowMinutes * 60 * 1000);

  console.log(`[poll] checkpoint: ${checkpoint ? checkpoint.toISOString() : '(none, using default window)'}`);
  await processCallsForRange(start, end);
  await setCheckpoint(end);

  await maybeSendScheduledReport();
}

// This one process/schedule (every ~15 min) also carries the reports: whenever the
// Kyiv-local clock hits one of REPORT_HOURS and that slot hasn't fired yet today, send a
// report covering everything since the previous report (not the whole day) - so back-to-back
// slots each show fresh activity instead of repeating the same data.
async function maybeSendScheduledReport() {
  const { dateStr: today, hour } = kyivDateParts();
  if (!REPORT_HOURS.includes(hour)) return;

  const slotKey = `${today}-${hour}`;
  const lastSlot = await getLastReportSlot();
  if (lastSlot === slotKey) return;

  const end = new Date();
  const lastUntil = await getLastReportUntil();
  const start = lastUntil || kyivMidnightUtc(today); // very first report ever: since start of today

  console.log(`[poll] Kyiv hour is ${hour} (report slot ${slotKey}) - generating report for ${start.toISOString()} -> ${end.toISOString()}`);
  await generateDailyReport({ start, end });
  await setLastReportSlot(slotKey);
  await setLastReportUntil(end);
}

module.exports = { pollNewCalls };
