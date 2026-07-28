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

// ============================================================================================
// Persisted analytics: the report "reduce" per (manager × time segment) is computed ONCE and frozen
// in report_segments, so repeated / incremental reports REUSE it instead of re-analysing from
// scratch. Segments are day-bounded (Kyiv), split by the report-time slots — see kyivDaySegments.
//
//   • A completed day-bounded segment [boundary, slot] is a 'scheduled' segment — immutable, the
//     growth time series. Analysed with SELF-CONSISTENCY (PASSES) because it won't be re-run.
//   • The in-progress remainder [last boundary, now] is a 'manual_tail' — ephemeral, single-pass,
//     deduped by call_ids so a rapid double-click reuses it. It becomes a scheduled segment (with
//     full passes) once its slot completes.
//
// A report for any period = the frozen scheduled segments it covers + a live tail. Numeric stats are
// ALWAYS live for the exact period (cheap SQL) — only the LLM findings are cached.
// ============================================================================================

const SEGMENT_ANALYSIS_VERSION = 1; // bump to invalidate & recompute stored segments on next read
const PASSES = Math.max(1, Number(process.env.SEGMENT_CONSISTENCY_PASSES || 3));
const RECENT_MS = 24 * 3600 * 1000; // only re-check call-set membership for segments this fresh

const shortHash = (s) => createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
const sameSet = (a, b) => {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
};

// All day-bounded segments (Kyiv) overlapping [periodStart, periodEnd], across as many days as the
// period spans. Walks day by day (each day's last segment ends at the next midnight).
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
    cursor = daySegs[daySegs.length - 1].end; // advance to next midnight
  }
  return out;
}

// What logic/config produced a snapshot — stored for authenticity/invalidation (not used to reuse
// in phase 1; reuse keys on exact period + analysis_version).
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
    if (c.callPurpose === 'info' || c.callPurpose === 'other') return n;
    return n + (c.behaviors?.items?.length || 0);
  }, 0);
}

// Compute a segment's analysis payload, or null if the manager had no calls in it.
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

// Reuse the frozen 'scheduled' segment, or compute + store it (self-consistency). Self-heals a
// RECENT segment if a late-ingested call changed its call set. Returns the stored row, or null when
// the manager had no calls in the segment.
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

// Ephemeral tail [start, end] for a manual report. Deduped: an existing manual_tail with the same
// call set is reused as-is (double-click → no re-analysis). Single pass (not frozen). Null if no
// calls in the tail.
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

// Assemble a report for [periodStart, periodEnd]: frozen scheduled segments (reused/computed) + a
// live tail for the in-progress remainder. Numeric stats are always LIVE for the exact period.
// Returns { name, stats, blocks:[{start,end,kind,findings,phrases,stats}], phrases, start, end } or
// null when the manager has no calls in the whole period.
async function assembleReport(name, periodStart, periodEnd) {
  const stats = await getOperatorStats(name, periodStart, periodEnd);
  if (!stats.callCount) return null;

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

// ============================================================================================
// MULTI-DAY periods (week / month / quarter) — analysed PER DAY and cached as kind='day'.
//
// Why a separate granularity from the slot-bounded 'scheduled' segments: those exist to be an
// immutable growth time series tied to the report slots, and a month covers ~90 of them. A whole DAY
// is the natural unit for a period report — ~20 units for a month instead of 90, each with more
// candidates (so clustering is better), and each cached forever, so the next report over an
// overlapping range reuses everything except the new days.
//
// Single pass (not PASSES): self-consistency exists for the frozen scheduled series that is never
// recomputed. Here we trade it for wall-clock — a month must not take minutes. Days are analysed a
// few at a time (CONCURRENCY) for the same reason.
//
// Cost note: a day whose sales calls yield fewer than MIN_EVIDENCE candidates costs NOTHING — the
// reduce short-circuits before any LLM call — and the empty result is still cached, so it is never
// retried.
// ============================================================================================

const DAY_KIND = 'day';
const RANGE_PASSES = 1;
const CONCURRENCY = 4;

// Kyiv midnight-to-midnight days overlapping [start, end). Reuses kyivDaySegments with NO slots, so
// each "day segment" is exactly one calendar day in Kyiv (DST-safe — see time.js).
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

// One day's analysis: reuse the cached row when it is current, otherwise compute + store it.
// analyze:false makes this reuse-ONLY (the quarter path) — it returns null instead of paying for an
// analysis. Self-heals a recent day whose call set changed (a late-ingested call).
async function getOrComputeDaySegment(name, start, end, { analyze = true } = {}) {
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
  await upsertReportSegment({
    managerName: name, periodStart: start, periodEnd: end, kind: DAY_KIND,
    ...seg, analysisVersion: SEGMENT_ANALYSIS_VERSION,
  });
  return getStoredSegment(name, start, end, DAY_KIND);
}

// Run tasks with a small concurrency cap, preserving input order in the result.
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

// Collect a multi-day period's findings: every day analysed (or reused), flattened into ONE pool.
// Returns { stats, findings, phrases, days, analysedDays, missingDays } or null when the manager has
// no calls in the period at all. The CALLER (report.js) merges the pooled findings into a single
// coherent list — see analyze.js: mergeFindings.
async function collectRangeFindings(name, periodStart, periodEnd, { analyze = true } = {}) {
  const stats = await getOperatorStats(name, periodStart, periodEnd);
  if (!stats.callCount) return null;

  const days = enumerateDays(periodStart, periodEnd);
  let missingDays = 0;

  if (!analyze) {
    // Reuse-only: take whatever is already stored, at ANY granularity — the day segments a previous
    // week/month report cached AND the slot segments the auto-reports froze. Maximum reuse for free.
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

  const rows = await mapLimit(days, CONCURRENCY, (d) => getOrComputeDaySegment(name, d.start, d.end, { analyze: true }));
  const present = rows.filter(Boolean);
  return {
    stats,
    findings: present.flatMap((r) => r.findings || []),
    phrases: dedupPhrases(present.flatMap((r) => r.phrases || [])),
    days: days.length,
    analysedDays: present.length,
    missingDays: 0,
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
