import { withRetry } from './retry.js';
import { httpError } from './errors.js';
import { fetchRaw } from './http.js';
import { directionOf } from './callDirection.js';

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
        if (res.status >= 500) err.binotelUnavailable = true;
        throw err;
      }
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
      if (data.status === 'error') {
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

function extractClientName(call) {
  const raw = call.customerData?.name || call.customerDataFromOutside?.name || '';
  const name = String(raw).replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (/^new client\b/i.test(name)) return null;
  if (/^\+?[\d\s\-()]+$/.test(name)) return null;
  return name;
}

async function listCallsForPeriod(startDate, endDate) {
  const data = await callBinotel('stats/list-of-calls-for-period.json', {
    startTime: toUnixSeconds(startDate),
    stopTime: toUnixSeconds(endDate),
  });
  const calls = Object.values(data.callDetails || {});
  return calls.map((c) => ({
    generalCallId: c.generalCallID,
    internalNumber: c.internalNumber,
    employeeName: c.employeeData?.name || null,
    clientNumber: c.externalNumber || null,
    direction: directionOf(c.callType),
    clientName: extractClientName(c),
    hangupBy: c.whoHungUp || null,
    startTime: new Date(Number(c.startTime) * 1000).toISOString(),
    durationSec: Number(c.billsec || 0),
    recordingStatus: c.recordingStatus,
  }));
}

async function getCallRecordUrl(generalCallId) {
  const data = await callBinotel('stats/call-record.json', {
    generalCallID: generalCallId,
    callID: generalCallId,
  });
  return data.url || data.response?.record || data.record;
}

export { listCallsForPeriod, getCallRecordUrl, extractClientName };
