const { google } = require('googleapis');
const { withRetry } = require('./retry');

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Appends one row per manager for the given day to the "Raw" sheet. The owner builds
// trend charts/pivot tables in a separate "Dashboard" tab with QUERY formulas pointing
// at this growing range - no code needed on our side to add new charts later.
async function appendDailyStats(dateStr, statsRows) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log('[sheets] DRY RUN (no GOOGLE_SHEET_ID/GOOGLE_SERVICE_ACCOUNT_JSON set) - would append:');
    console.log(JSON.stringify(statsRows, null, 2));
    return;
  }

  const sheets = getSheetsClient();
  const values = statsRows.map((r) => [
    dateStr,
    r.managerName,
    r.callCount,
    r.successCount,
    r.callCount > 0 ? Math.round((r.successCount / r.callCount) * 100) : 0,
    r.avgScore,
    r.topWeakStage || '',
  ]);

  await withRetry(
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Raw!A:G',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      }),
    { attempts: 3, delayMs: 1500, label: 'Google Sheets append' }
  );
  console.log(`[sheets] appended ${values.length} row(s) for ${dateStr}`);
}

module.exports = { appendDailyStats };
