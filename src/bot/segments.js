import { createHash } from 'node:crypto';
import {
  getOperatorStats,
  getCallsForReport,
  getStoredSegment,
  getStoredSegmentsInRange,
  getLatestManualTail,
  upsertReportSegment,
  getCallIdsForOperator,
  getReportTimes,
} from '../core/store.js';
import { reduceFindingsConsistent, getAnalyzePrompt, MAX_PHRASES } from './analyze.js';
import { getScoreRubric } from '../core/classifyCall.js';
import { kyivDaySegments } from './time.js';
import { NON_SALES_PURPOSES } from '../core/callPurpose.js';


const SEGMENT_ANALYSIS_VERSION = 1;
const PASSES = Math.max(1, Number(process.env.SEGMENT_CONSISTENCY_PASSES || 3));
const RECENT_MS = 24 * 3600 * 1000;

const shortHash = (s) => createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
const sameSet = (a, b) => {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
};

function enumerateSegments(periodStart, periodEnd, slots) {
  const out = [];
  let cursor = new Date(periodStart);
  let guard = 0;
  while (cursor.getTime() < periodEnd.getTime() && guard < 800) {
    guard += 1;
    const daySegs = kyivDaySegments(cursor, slots);
    for (const s of daySegs) {
      if (s.end.getTime() <= periodStart.getTime()) continue;
      if (s.start.getTime() >= periodEnd.getTime()) continue;
      out.push(s);
    }
    cursor = daySegs[daySegs.length - 1].end;
  }
  return out;
}

async function segmentMeta(passes) {
  const [rubric, prompt] = await Promise.all([getScoreRubric(), getAnalyzePrompt()]);
  return {
    rubricHash: shortHash(rubric),
    promptHash: shortHash(prompt),
    model: process.env.OPENAI_REPORT_MODEL || 'gpt-4o',
    passes,
  };
}

function candidateCount(calls) {
  return calls.reduce((n, c) => {
    if (NON_SALES_PURPOSES.includes(c.callPurpose)) return n;
    return n + (c.behaviors?.items?.length || 0);
  }, 0);
}

async function analyzeSegment(name, start, end, passes) {
  const stats = await getOperatorStats(name, start, end);
  if (!stats.callCount) return null;
  const calls = await getCallsForReport(name, start, end);
  const { findings, phrases } = await reduceFindingsConsistent(name, calls, stats, passes);
  return {
    findings,
    phrases,
    stats,
    callIds: calls.map((c) => c.generalCallId),
    candidateCount: candidateCount(calls),
    meta: await segmentMeta(passes),
  };
}

function toBlock(row, kind) {
  return {
    start: new Date(row.periodStart),
    end: new Date(row.periodEnd),
    kind,
    findings: row.findings || [],
    phrases: row.phrases || [],
    stats: row.stats || null,
  };
}

async function getOrComputeScheduledSegment(name, start, end) {
  const existing = await getStoredSegment(name, start, end, 'scheduled');
  if (existing && (existing.analysisVersion || 0) >= SEGMENT_ANALYSIS_VERSION) {
    const recent = Date.now() - new Date(end).getTime() < RECENT_MS;
    if (!recent) return existing;
    const currentIds = await getCallIdsForOperator(name, start, end);
    if (sameSet(existing.callIds || [], currentIds)) return existing;
    console.log(`[segments] scheduled ${name} ${start.toISOString?.() ?? start}..${end.toISOString?.() ?? end}: call set changed → recompute`);
  }
  const seg = await analyzeSegment(name, start, end, PASSES);
  if (!seg) return null;
  await upsertReportSegment({
    managerName: name, periodStart: start, periodEnd: end, kind: 'scheduled',
    ...seg, analysisVersion: SEGMENT_ANALYSIS_VERSION,
  });
  return getStoredSegment(name, start, end, 'scheduled');
}

async function computeTail(name, start, end) {
  const currentIds = await getCallIdsForOperator(name, start, end);
  if (!currentIds.length) return null;
  const prev = await getLatestManualTail(name, start);
  if (prev && sameSet(prev.callIds || [], currentIds)) return toBlock(prev, 'manual_tail');
  const seg = await analyzeSegment(name, start, end, 1);
  if (!seg) return null;
  await upsertReportSegment({
    managerName: name, periodStart: start, periodEnd: end, kind: 'manual_tail',
    ...seg, analysisVersion: SEGMENT_ANALYSIS_VERSION,
  });
  return { start, end, kind: 'manual_tail', findings: seg.findings, phrases: seg.phrases, stats: seg.stats };
}

function dedupPhrases(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const t = String(p || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_PHRASES) break;
  }
  return out;
}

async function assembleReport(name, periodStart, periodEnd) {
  const stats = await getOperatorStats(name, periodStart, periodEnd);
  if (!stats.callCount) return { name, stats, blocks: [], phrases: [], start: periodStart, end: periodEnd };

  const slots = await getReportTimes();
  const segs = enumerateSegments(periodStart, periodEnd, slots);
  const full = segs.filter(
    (s) => s.start.getTime() >= periodStart.getTime() && s.end.getTime() <= periodEnd.getTime()
  );
  const coveredUntil = full.length ? full[full.length - 1].end : periodStart;

  const blocks = [];
  for (const s of full) {
    const row = await getOrComputeScheduledSegment(name, s.start, s.end);
    if (row) blocks.push(toBlock(row, 'scheduled'));
  }
  if (coveredUntil.getTime() < periodEnd.getTime()) {
    const tail = await computeTail(name, coveredUntil, periodEnd);
    if (tail) blocks.push(tail);
  }

  const phrases = dedupPhrases(blocks.flatMap((b) => b.phrases || []));
  return { name, stats, blocks, phrases, start: periodStart, end: periodEnd };
}


const DAY_KIND = 'day';
const RANGE_PASSES = 1;
const CONCURRENCY = 4;

function enumerateDays(start, end) {
  const out = [];
  let cursor = new Date(start);
  let guard = 0;
  while (cursor.getTime() < end.getTime() && guard < 400) {
    guard += 1;
    const [day] = kyivDaySegments(cursor, []);
    out.push(day);
    cursor = day.end;
  }
  return out;
}

async function getOrComputeDaySegment(name, start, end, { analyze = true, onComputed = null } = {}) {
  const existing = await getStoredSegment(name, start, end, DAY_KIND);
  if (existing && (existing.analysisVersion || 0) >= SEGMENT_ANALYSIS_VERSION) {
    const recent = Date.now() - new Date(end).getTime() < RECENT_MS;
    if (!recent) return existing;
    const currentIds = await getCallIdsForOperator(name, start, end);
    if (sameSet(existing.callIds || [], currentIds)) return existing;
  }
  if (!analyze) return null;
  const seg = await analyzeSegment(name, start, end, RANGE_PASSES);
  if (!seg) return null;
  if (onComputed) await onComputed();
  await upsertReportSegment({
    managerName: name, periodStart: start, periodEnd: end, kind: DAY_KIND,
    ...seg, analysisVersion: SEGMENT_ANALYSIS_VERSION,
  });
  return getStoredSegment(name, start, end, DAY_KIND);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function collectRangeFindings(
  name,
  periodStart,
  periodEnd,
  { analyze = true, concurrency = CONCURRENCY, pauseMs = 0, deadline = null } = {}
) {
  const stats = await getOperatorStats(name, periodStart, periodEnd);
  const days = enumerateDays(periodStart, periodEnd);
  if (!stats.callCount) {
    return { stats, findings: [], phrases: [], days: days.length, analysedDays: 0, missingDays: 0 };
  }

  let missingDays = 0;

  if (!analyze) {
    const rows = await getStoredSegmentsInRange(name, periodStart, periodEnd, [DAY_KIND, 'scheduled']);
    const covered = new Set(rows.map((r) => new Date(r.periodStart).toISOString().slice(0, 10)));
    for (const d of days) if (!covered.has(d.start.toISOString().slice(0, 10))) missingDays += 1;
    return {
      stats,
      findings: rows.flatMap((r) => r.findings || []),
      phrases: dedupPhrases(rows.flatMap((r) => r.phrases || [])),
      days: days.length,
      analysedDays: rows.length,
      missingDays,
    };
  }

  let failedDays = 0;
  let ranOutOfTime = false;
  const pause = pauseMs ? () => new Promise((r) => setTimeout(r, pauseMs)) : null;

  const stored = await getStoredSegmentsInRange(name, periodStart, periodEnd, [DAY_KIND]);
  const fresh = new Map();
  for (const row of stored) {
    if ((row.analysisVersion || 0) < SEGMENT_ANALYSIS_VERSION) continue;
    if (Date.now() - new Date(row.periodEnd).getTime() < RECENT_MS) continue;
    fresh.set(new Date(row.periodStart).toISOString().slice(0, 10), row);
  }

  const pending = days.filter((d) => !fresh.has(d.start.toISOString().slice(0, 10)));

  const computed = await mapLimit(pending, concurrency, async (d) => {
    const expired = deadline != null && Date.now() > deadline;
    if (expired) ranOutOfTime = true;
    try {
      return await getOrComputeDaySegment(name, d.start, d.end, { analyze: !expired, onComputed: pause });
    } catch (err) {
      failedDays += 1;
      console.error(`[segments] ${name} ${d.start.toISOString().slice(0, 10)} не порахувався: ${err.message}`);
      return null;
    }
  });

  const present = [...fresh.values(), ...computed.filter(Boolean)];
  return {
    stats,
    findings: present.flatMap((r) => r.findings || []),
    phrases: dedupPhrases(present.flatMap((r) => r.phrases || [])),
    days: days.length,
    analysedDays: present.length,
    missingDays: failedDays,
    failedDays,
    ranOutOfTime,
  };
}

export {
  assembleReport,
  getOrComputeScheduledSegment,
  collectRangeFindings,
  enumerateDays,
  analyzeSegment,
  enumerateSegments,
  SEGMENT_ANALYSIS_VERSION,
  PASSES,
};
