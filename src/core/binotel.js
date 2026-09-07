import { withRetry } from './retry.js';
import { httpError } from './errors.js';
import { fetchRaw } from './http.js';

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
      const res = await fetchRaw('binotel', path, `${BASE_URL}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...auth(), ...body }),
      });
      if (!res.ok) {
        const err = await httpError('binotel', path, res);
        // 5xx is Binotel being broken, not us - let the poller report it as an outage.
        if (res.status >= 500) err.binotelUnavailable = true;
        throw err;
      }
      // Read the body ourselves instead of res.json(). When Binotel's own API application throws,
      // it answers HTTP 200 with content-type text/html and the body "Something went wrong
      // (exception)" - verified on 2026-09-06, when EVERY method (including a nonexistent one and
      // deliberately wrong credentials) returned exactly that for ~7 hours. res.json() then died
      // with "Unexpected token 'S', \"Something \"... is not valid JSON", which reads like a bug in
      // OUR parsing and completely hides the fact that the upstream is simply down. Parsing here
      // lets the error say what actually happened, and tags it so the poller can dedupe the alert
      // (see jobs/pollNewCalls.js) instead of shouting every 15 minutes for the whole outage.
      const rawBody = await res.text();
      let data;
      try {
        data = JSON.parse(rawBody);
      } catch {
        const contentType = res.headers.get('content-type') || 'no content-type';
        const snippet = rawBody.trim().slice(0, 200) || '(empty body)';
        const err = new Error(
          `Binotel ${path} returned non-JSON (HTTP ${res.status}, ${contentType}): ${snippet}`
        );
        err.provider = 'binotel';
        err.op = path;
        err.status = res.status;
        err.body = snippet;
        err.binotelUnavailable = true;
        throw err;
      }
      console.log(`[binotel] response from ${path}:`, JSON.stringify(data).slice(0, 500));
      // Binotel reports API-level failures (e.g. rate limiting: "Requests are too frequent") with
      // HTTP 200 + {status:"error",...} - res.ok alone misses this entirely. Left unchecked, a
      // rate-limited list-of-calls-for-period silently looked like "zero calls in this period" to
      // every caller (no exception, no retry, no log), which is exactly the kind of silent data
      // loss this project's checkpoint/pending_calls design exists to prevent. Throwing here makes
      // withRetry actually retry it, and - for the poller - means the checkpoint isn't advanced
      // past a period Binotel never really confirmed, so the next poll retries the same window.
      if (data.status === 'error') {
        // binotelCode робить клас однозначним: 106 - це тротлінг, 104 - немає запису, і поводитись
        // з ними треба по-різному (перше варто повторити, друге - ніколи).
        const err = new Error(`Binotel ${path} returned an error: ${data.code} ${data.message}`);
        err.provider = 'binotel';
        err.op = path;
        err.binotelCode = Number(data.code);
        err.description = data.message;
        throw err;
      }
      return data;
    },
    { attempts: 3, delayMs: 2000, label: `binotel ${path}` }
  );
}

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

// The CLIENT's name, if anyone ever labelled them. Verified against the live account on 2026-07-27:
// Binotel's own address book (`customerData`) is EMPTY here, and the name actually arrives in
// `customerDataFromOutside` — the CRM integration (CarBook) — so both are checked, native first.
// Two shapes must NOT be treated as a name:
//   • "New client 0973127982" — the CRM's auto-generated placeholder for an unrecognised caller;
//   • a "name" that is just the phone number again.
// Names also come padded/double-spaced ("Сергій  ", "Костянтин  Борисовський Євгенович"), hence the
// whitespace collapse. Returns null when the client is genuinely unlabelled.
function extractClientName(call) {
  const raw = call.customerData?.name || call.customerDataFromOutside?.name || '';
  const name = String(raw).replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (/^new client\b/i.test(name)) return null;
  if (/^\+?[\d\s\-()]+$/.test(name)) return null;
  return name;
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
    // Whoever the client is called in the CRM (null when unlabelled) - shown in the archive.
    clientName: extractClientName(c),
    // WHO ENDED THE CALL. Binotel documents whoHungUp as part of the apiCallCompleted WEBHOOK, and
    // the field is present in the REST response schema too — but it is EMPTY on this account: 458
    // calls over 30 days (345 of them answered, both directions), via both
    // list-of-calls-for-period and call-details, returned "" every single time (checked 2026-07-28).
    // So it is captured here but nothing is built on it: the moment Binotel starts populating it (a
    // support request / the webhook), real values begin accumulating and the check can be wired up.
    // Deliberately NOT guessed from the transcript — the owner rejected a heuristic, and rightly so:
    // "the manager spoke last" is not the same as "the manager hung up".
    hangupBy: c.whoHungUp || null,
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

export { listCallsForPeriod, getCallRecordUrl, extractClientName };
