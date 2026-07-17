import { InputFile } from 'grammy';
import {
  getCallsWithTranscriptsInRange,
  getReportSlot,
  setReportSlot,
  getReportUntil,
  setReportUntil,
} from '../core/store.js';
import { analyzeManager } from './analyze.js';
import { withProgress } from './ui.js';
import { generateReportPdf } from './pdfReport.js';
import { displayName } from './operators.js';
import { kyivParts, startOfDay, formatKyiv, shortDate } from './time.js';

const REPORT_TIMES = (process.env.BOT_REPORT_TIMES || '13:00,19:30')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function groupByManager(rows) {
  const groups = new Map();
  for (const r of rows) {
    const name = r.managerName || 'Невідомий менеджер';
    if (!groups.has(name)) groups.set(name, { name, calls: [] });
    groups.get(name).calls.push(r);
  }
  return [...groups.values()];
}

// Builds the per-manager analyses for [start, end). Returns { managerReports, totalCalls,
// periodLabel } or null when there were no processed calls in the period. managerReports is
// shaped for pdfReport.js (one entry -> one page). Manager names are aliased for display
// (displayName), so e.g. the director's number shows as "Богдан" in the PDF too.
async function buildReport(start, end) {
  const rows = await getCallsWithTranscriptsInRange(start, end);
  if (rows.length === 0) return null;

  const groups = groupByManager(rows);
  const managerReports = [];
  for (const g of groups) {
    const name = displayName(g.name);
    try {
      const { stats, summary } = await analyzeManager(g.name, g.calls);
      const rate = stats.callCount ? Math.round((stats.successCount / stats.callCount) * 100) : 0;
      managerReports.push({
        managerName: name,
        subtitle: `${stats.callCount} дзв. · успішність ${rate}% · середній бал ${stats.avgScore ?? '—'}`,
        reportText: summary,
      });
    } catch (err) {
      managerReports.push({
        managerName: name,
        subtitle: '',
        reportText: `Не вдалося згенерувати аналіз: ${err.message}`,
      });
    }
  }

  const periodLabel = `${formatKyiv(start)} – ${formatKyiv(end)}`;
  return { managerReports, totalCalls: rows.length, periodLabel };
}

// Generates the PDF report and sends it as a document. Used by BOTH the scheduled reports
// (13:00 / 19:30) and the manual "Звіт зараз", so the format is identical everywhere.
async function sendReport(api, chatId, start, end) {
  const built = await buildReport(start, end);
  if (!built) return { sent: false, empty: true };

  const { managerReports, totalCalls, periodLabel } = built;
  const pdf = await generateReportPdf(managerReports, { periodLabel });
  const filename = `zvit_${shortDate(start).replace(/\./g, '-')}_${shortDate(end).replace(/\./g, '-')}.pdf`;
  const caption =
    `📊 Звіт за період\n${periodLabel}\n` +
    `Менеджерів: ${managerReports.length}, дзвінків: ${totalCalls}`;
  await api.sendDocument(chatId, new InputFile(pdf, filename), { caption });
  return { sent: true };
}

// Manual "report now": covers today so far and does NOT touch the scheduler state, so it can't
// disturb the next automatic slot.
async function sendManualReport(api, chatId) {
  const end = new Date();
  // Report generation calls OpenAI once per manager then renders a PDF (15-40s total); keep an
  // "надсилає документ" indicator alive so the chat doesn't look frozen while it works.
  const res = await withProgress(
    api,
    chatId,
    'upload_document',
    () => sendReport(api, chatId, startOfDay(end), end),
    { notice: '⏳ Бот формує PDF-звіт, це може зайняти деякий час…' }
  );
  if (res.empty) await api.sendMessage(chatId, 'За сьогодні ще немає оброблених дзвінків для звіту.');
  return res;
}

let running = false;

// Fires once per configured time slot (Kyiv). Period = since the previous automatic report
// (or start of today on the very first run), so back-to-back slots never overlap or leave a
// gap. Slot dedup (app_state.last_report_slot) survives restarts; the in-memory lock prevents
// a double-fire within the same minute.
async function maybeSendScheduledReport(api, chatId) {
  const now = new Date();
  const { dateStr, hhmm } = kyivParts(now);
  if (!REPORT_TIMES.includes(hhmm)) return;

  const slotKey = `${dateStr}-${hhmm}`;
  if (running) return;
  if ((await getReportSlot()) === slotKey) return;

  running = true;
  try {
    const end = now;
    const start = (await getReportUntil()) || startOfDay(now);
    console.log(`[bot] scheduled report slot ${slotKey}: ${start.toISOString()} -> ${end.toISOString()}`);
    const res = await sendReport(api, chatId, start, end);
    await setReportSlot(slotKey);
    await setReportUntil(end);
    if (res.empty) console.log('[bot] scheduled report: nothing to send this period');
  } finally {
    running = false;
  }
}

function startScheduler(api, chatId) {
  console.log(`[bot] report scheduler on for ${REPORT_TIMES.join(', ')} (Kyiv), recipient chat ${chatId}`);
  setInterval(() => {
    maybeSendScheduledReport(api, chatId).catch((e) => console.error(`[bot] scheduled report error: ${e.message}`));
  }, 30000);
}

export { buildReport, sendReport, sendManualReport, startScheduler };
