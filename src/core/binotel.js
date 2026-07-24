import { withRetry } from './retry.js';

const BASE_URL = process.env.BINOTEL_BASE_URL || 'https://api.binotel.com/api/4.0';

function auth() {
  return {
    key: process.env.BINOTEL_API_KEY,
    secret: process.env.BINOTEL_API_SECRET,
  };
}

async function callBinotel(path, body) {
  return withRetry(
    async () => {
      console.log(`[binotel] POST ${path}`, JSON.stringify(body));
      const res = await fetch(`${BASE_URL}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...auth(), ...body }),
      });
      if (!res.ok) {
        throw new Error(`Binotel ${path} failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      console.log(`[binotel] response from ${path}:`, JSON.stringify(data).slice(0, 500));
      // Binotel reports API-level failures (e.g. rate limiting: "Requests are too frequent") with
      // HTTP 200 + {status:"error",...} - res.ok alone misses this entirely. Left unchecked, a
      // rate-limited list-of-calls-for-period silently looked like "zero calls in this period" to
      // every caller (no exception, no retry, no log), which is exactly the kind of silent data
      // loss this project's checkpoint/pending_calls design exists to prevent. Throwing here makes
      // withRetry actually retry it, and - for the poller - means the checkpoint isn't advanced
      // past a period Binotel never really confirmed, so the next poll retries the same window.
      if (data.status === 'error') {
        throw new Error(`Binotel ${path} returned an error: ${data.code} ${data.message}`);
      }
      return data;
    },
    { attempts: 3, delayMs: 2000, label: `binotel ${path}` }
  );
}

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

// Confirmed against a real account on 2026-07-06: callDetails is an OBJECT keyed by
// generalCallID, not an array. Binotel caps this method at a 24h window.
async function listCallsForPeriod(startDate, endDate) {
  const data = await callBinotel('stats/list-of-calls-for-period.json', {
    startTime: toUnixSeconds(startDate),
    stopTime: toUnixSeconds(endDate),
  });
  const calls = Object.values(data.callDetails || {});
  return calls.map((c) => ({
    generalCallId: c.generalCallID,
    internalNumber: c.internalNumber,
    // employeeData.name is populated for calls answered on a personal extension (confirmed
    // for 903). Shared-handset extensions may not carry a name - callers fall back to the
    // raw internalNumber when this is empty.
    employeeName: c.employeeData?.name || null,
    // The CLIENT's phone number (the other party on the call, not ours). Raw Binotel shape,
    // e.g. "0971532839" - formatted to +380... on display (bot/operators.js: formatPhone).
    clientNumber: c.externalNumber || null,
    startTime: new Date(Number(c.startTime) * 1000).toISOString(),
    durationSec: Number(c.billsec || 0),
    recordingStatus: c.recordingStatus,
  }));
}

// Binotel support's email used "generalCallID" for this endpoint, but the underlying
// SDK docs call it "callID" - sending both since they're confirmed to hold the same value.
async function getCallRecordUrl(generalCallId) {
  const data = await callBinotel('stats/call-record.json', {
    generalCallID: generalCallId,
    callID: generalCallId,
  });
  return data.url || data.response?.record || data.record;
}

export { listCallsForPeriod, getCallRecordUrl };
