const { getTranscriptsInRange, getDailyStatsByManager } = require('./store');
const { generateManagerReport } = require('./analyze');
const { sendDocument, sendAlert } = require('./telegram');
const { previousKyivDayRange, formatKyivDateTime, kyivDateParts } = require('./time');
const { generateReportPdf } = require('./pdfReport');
const { appendDailyStats } = require('./sheetsSync');

function groupByManager(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.managerName || 'Невідомий менеджер';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

// Defaults to the previous full calendar day in Kyiv time (used by the local `npm run
// report` manual test). The real scheduled path (pollNewCalls.js) always passes an explicit
// range covering "since the previous report", which may be a partial day.
async function generateDailyReport(range) {
  const { start, end } = range || previousKyivDayRange();
  const periodLabel = `${formatKyivDateTime(start)} – ${formatKyivDateTime(end)}`;
  const fileDateStr = kyivDateParts(end).dateStr;

  console.log(`[report] collecting transcripts for ${start.toISOString()} -> ${end.toISOString()}`);
  const rows = await getTranscriptsInRange(start, end);
  console.log(`[report] found ${rows.length} transcripts for that period`);

  if (rows.length === 0) {
    console.log('[report] nothing to report, skipping PDF/send');
    return;
  }

  const groups = groupByManager(rows);
  console.log(`[report] grouped into ${groups.size} manager(s): ${[...groups.keys()].join(', ')}`);

  const managerReports = [];
  for (const [managerName, transcripts] of groups) {
    try {
      const reportText = await generateManagerReport(transcripts);
      managerReports.push({ managerName, callCount: transcripts.length, reportText });
    } catch (err) {
      console.error(`[report] FAILED to analyze ${managerName}: ${err.message}`);
      await sendAlert(`Не вдалося згенерувати аналіз для ${managerName}: ${err.message}`).catch(
        (e) => console.error(`[report] failed to send alert: ${e.message}`)
      );
    }
  }

  if (managerReports.length === 0) {
    console.error('[report] no manager reports succeeded, nothing to send');
    return;
  }

  try {
    const pdfBuffer = await generateReportPdf(managerReports, { periodLabel });
    const caption = `📊 Звіт аналізу дзвінків за ${periodLabel}\nАвтоматично згенеровано з транскриптів розмов менеджерів (${managerReports.length} менеджер(и), ${rows.length} дзвінків)`;
    await sendDocument(pdfBuffer, `zvit-${fileDateStr}-${kyivDateParts(end).hour}h.pdf`, caption);
    console.log('[report] PDF report sent');
  } catch (err) {
    console.error(`[report] FAILED to build/send PDF: ${err.message}`);
    await sendAlert(`Не вдалося сформувати або надіслати PDF-звіт за ${periodLabel}: ${err.message}`).catch(
      (e) => console.error(`[report] failed to send alert: ${e.message}`)
    );
  }

  try {
    const statsRows = await getDailyStatsByManager(start, end);
    await appendDailyStats(fileDateStr, statsRows);
  } catch (err) {
    console.error(`[report] FAILED to sync stats to Google Sheets: ${err.message}`);
    await sendAlert(`Не вдалося записати статистику в Google Sheets за ${periodLabel}: ${err.message}`).catch(
      (e) => console.error(`[report] failed to send alert: ${e.message}`)
    );
  }
}

module.exports = { generateDailyReport };
