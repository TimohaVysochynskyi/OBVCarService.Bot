import { createHash } from 'node:crypto';
import {
  getStoredSegment,
  upsertReportSegment,
  getGlobalTotals,
  getMonthlyPurposeBreakdown,
  getMonthlySalesStats,
  getWeakStageCounts,
  getAllBlockedCalls,
  getDeclineReasonCounts,
  getDeclineCoverage,
  getOperators,
} from '../core/store.js';
import { CALL_PURPOSES } from '../core/callPurpose.js';
import { BLOCKER_LABELS, BLOCKER_COLUMNS, DEAL_BLOCKERS } from '../core/dealBlocker.js';
import { reasonLabel, reasonSide } from '../core/declineReasons.js';
import { displayName, formatPhone } from './operators.js';
import { collectRangeFindings } from './segments.js';
import { mergeFindings } from './analyze.js';

const TOP_N = 3;
const ALL = 'all';
const MONTH_NAMES = [
  'січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
  'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень',
];

const emptyBucket = () => ({
  calls: 0,
  sales: 0,
  info: 0,
  other: 0,
  personal: 0,
  success: 0,
  reachable: 0,
  scoreSum: 0,
  scoreDays: 0,
  avgScore: null,
  blockedNoSlot: 0,
  blockedNoParts: 0,
  blockedOutOfScope: 0,
});

function monthTitle(month) {
  const [year, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${year}`;
}

function conversionOf(bucket) {
  return bucket.reachable ? Math.round((bucket.success / bucket.reachable) * 100) : null;
}

function addInto(target, source) {
  for (const key of ['calls', 'sales', 'info', 'other', 'personal', 'success', 'reachable', 'blockedNoSlot', 'blockedNoParts', 'blockedOutOfScope']) {
    target[key] += source[key] || 0;
  }
}

function buildManagerBuckets(purposeRows, salesRows) {
  const byManager = new Map();

  const bucketFor = (name, month) => {
    if (!byManager.has(name)) byManager.set(name, new Map());
    const months = byManager.get(name);
    if (!months.has(month)) months.set(month, emptyBucket());
    return months.get(month);
  };

  for (const row of purposeRows) {
    const purpose = CALL_PURPOSES.includes(row.purpose) ? row.purpose : 'other';
    const bucket = bucketFor(row.managerName, row.month);
    bucket[purpose] += row.count;
    bucket.calls += row.count;
  }

  for (const row of salesRows) {
    const bucket = bucketFor(row.managerName, row.month);
    bucket.success += row.successCount;
    bucket.reachable += row.reachableCount;
    bucket.blockedNoSlot += row.blockedNoSlot;
    bucket.blockedNoParts += row.blockedNoParts;
    bucket.blockedOutOfScope += row.blockedOutOfScope;
    if (row.avgScore != null && row.salesCount) {
      bucket.scoreSum += Number(row.avgScore) * row.salesCount;
      bucket.scoreDays += row.salesCount;
    }
  }

  for (const months of byManager.values()) {
    const total = emptyBucket();
    for (const bucket of months.values()) {
      bucket.avgScore = bucket.scoreDays ? Number((bucket.scoreSum / bucket.scoreDays).toFixed(1)) : null;
      bucket.conversion = conversionOf(bucket);
      addInto(total, bucket);
      total.scoreSum += bucket.scoreSum;
      total.scoreDays += bucket.scoreDays;
    }
    total.avgScore = total.scoreDays ? Number((total.scoreSum / total.scoreDays).toFixed(1)) : null;
    total.conversion = conversionOf(total);
    months.set(ALL, total);
  }

  return byManager;
}

function topFindings(findings, type) {
  return findings
    .filter((f) => f.type === type)
    .slice(0, TOP_N)
    .map((f) => ({
      claim: f.claim,
      why: f.why,
      action: f.action,
      examples: (f.evidence || []).slice(0, TOP_N).map((e) => ({
        quote: e.quote,
        note: e.note || null,
        at: e.startTime || null,
      })),
    }));
}

const GLOBAL_KIND = 'global';

const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const dayEnd = (d) => new Date(dayStart(d).getTime() + 24 * 3600 * 1000);

function inputHash(findings) {
  const shape = findings
    .map((f) => `${f.type}|${f.claim}|${(f.evidence || []).map((e) => `${e.callId}:${e.quote}`).sort().join(',')}`)
    .sort()
    .join(`
`);
  return createHash('sha1').update(shape).digest('hex').slice(0, 16);
}

async function mergeCached(name, start, end, findings) {
  const from = dayStart(start);
  const to = dayEnd(end);
  const hash = inputHash(findings);

  const stored = await getStoredSegment(name, from, to, GLOBAL_KIND).catch(() => null);
  if (stored && stored.meta?.inputHash === hash) return stored.findings || [];

  const errors = findings.filter((f) => f.type === 'error');
  const strengths = findings.filter((f) => f.type === 'strength');
  const mergedErrors = errors.length ? await mergeFindings(name, errors).catch(() => []) : [];
  const mergedStrengths = strengths.length ? await mergeFindings(name, strengths).catch(() => []) : [];
  const merged = [...mergedErrors, ...mergedStrengths];

  await upsertReportSegment({
    managerName: name,
    periodStart: from,
    periodEnd: to,
    kind: GLOBAL_KIND,
    findings: merged,
    candidateCount: findings.length,
    meta: { inputHash: hash },
  }).catch((err) => console.error(`[globalReport] кеш зведення не зберігся: ${err.message}`));

  return merged;
}

const EMPTY_FINDINGS = { strengths: [], weaknesses: [], analysedDays: 0, days: 0, partial: false };

async function collectWithFallback(name, start, end, opts) {
  if (!opts.analyze) {
    const collected = await collectRangeFindings(name, start, end, { analyze: false }).catch(() => null);
    return { collected, partial: true };
  }
  try {
    const collected = await collectRangeFindings(name, start, end, {
      analyze: true,
      concurrency: opts.concurrency,
      pauseMs: opts.pauseMs,
      deadline: opts.deadline,
    });
    return { collected, partial: Boolean(collected?.failedDays || collected?.ranOutOfTime) };
  } catch (err) {
    console.error(`[globalReport] аналіз ${name} не завершився (${err.message}); беремо те, що вже пораховано`);
    const collected = await collectRangeFindings(name, start, end, { analyze: false }).catch(() => null);
    return { collected, partial: true };
  }
}

async function managerFindings(name, start, end, opts) {
  const { collected, partial } = await collectWithFallback(name, start, end, opts);
  if (!collected?.findings?.length) {
    return { ...EMPTY_FINDINGS, analysedDays: collected?.analysedDays || 0, days: collected?.days || 0, partial };
  }

  const merged = await mergeCached(name, start, end, collected.findings);

  return {
    weaknesses: topFindings(merged, 'error'),
    strengths: topFindings(merged, 'strength'),
    analysedDays: collected.analysedDays,
    days: collected.days,
    partial,
  };
}

function buildDeclines(blockedCalls, reasonRows, coverage) {
  const buckets = Object.fromEntries(DEAL_BLOCKERS.map((b) => [b, 0]));
  const cases = [];

  for (const call of blockedCalls) {
    if (call.isSuccess) continue;
    buckets[call.blocker] = (buckets[call.blocker] || 0) + 1;
    cases.push({
      at: call.startTime,
      manager: displayName(call.managerName) || call.managerName,
      bucket: call.blocker,
      bucketLabel: BLOCKER_COLUMNS[call.blocker] || call.blocker,
      bucketFull: BLOCKER_LABELS[call.blocker] || call.blocker,
      reason: call.reason ? reasonLabel(call.reason) : null,
      quote: call.quote,
      clientName: call.clientName || null,
      clientPhone: call.clientNumber ? formatPhone(call.clientNumber) : null,
    });
  }

  const reasons = reasonRows
    .map((r) => ({
      key: r.reason,
      label: reasonLabel(r.reason) || r.reason,
      side: reasonSide(r.reason) || r.side,
      count: r.count,
    }))
    .sort((a, b) => b.count - a.count);

  const serviceTotal = Object.values(buckets).reduce((n, v) => n + v, 0);

  return {
    buckets,
    bucketLabels: Object.fromEntries(DEAL_BLOCKERS.map((b) => [b, BLOCKER_COLUMNS[b]])),
    serviceTotal,
    cases,
    reasons,
    coverage,
  };
}

const REPORT_CONCURRENCY = Number(process.env.GLOBAL_REPORT_CONCURRENCY || 1);
const REPORT_PAUSE_MS = Number(process.env.GLOBAL_REPORT_PAUSE_MS || 1500);
const REPORT_BUDGET_MS = Number(process.env.GLOBAL_REPORT_BUDGET_MS || 120000);

async function buildGlobalReport({
  analyze = true,
  concurrency = REPORT_CONCURRENCY,
  pauseMs = REPORT_PAUSE_MS,
  budgetMs = REPORT_BUDGET_MS,
} = {}) {
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : null;
  const [totals, purposeRows, salesRows, stageRows, blockedCalls, reasonRows, coverage, operators] = await Promise.all([
    getGlobalTotals(),
    getMonthlyPurposeBreakdown(),
    getMonthlySalesStats(),
    getWeakStageCounts(),
    getAllBlockedCalls(),
    getDeclineReasonCounts(),
    getDeclineCoverage(),
    getOperators(),
  ]);

  const months = [...new Set(purposeRows.map((r) => r.month))].sort();
  const byManager = buildManagerBuckets(purposeRows, salesRows);

  const people = operators
    .filter((o) => !/^[0-9]+$/.test(o.name))
    .sort((a, b) => b.n - a.n);

  const start = new Date(totals.firstCall);
  const end = new Date(totals.lastCall);

  const managers = [];
  for (const person of people) {
    const monthsMap = byManager.get(person.name) || new Map();
    const findings = await managerFindings(person.name, start, new Date(end.getTime() + 1000), {
      analyze,
      concurrency,
      pauseMs,
      deadline,
    });
    managers.push({
      name: person.name,
      display: displayName(person.name) || person.name,
      byMonth: Object.fromEntries([...monthsMap.entries()]),
      ...findings,
    });
  }

  const stages = new Map();
  for (const row of stageRows) stages.set(row.stage, (stages.get(row.stage) || 0) + row.count);

  const purposeTotals = Object.fromEntries(CALL_PURPOSES.map((p) => [p, 0]));
  for (const row of purposeRows) {
    const purpose = CALL_PURPOSES.includes(row.purpose) ? row.purpose : 'other';
    purposeTotals[purpose] += row.count;
  }

  return {
    generatedAt: new Date().toISOString(),
    period: { start: start.toISOString(), end: end.toISOString() },
    totals: {
      calls: totals.calls,
      seconds: totals.seconds,
      hours: Number((totals.seconds / 3600).toFixed(1)),
      managers: totals.managers,
      purposes: purposeTotals,
    },
    months: months.map((m) => ({ key: m, title: monthTitle(m) })),
    managers,
    stages: [...stages.entries()].map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count),
    declines: buildDeclines(blockedCalls, reasonRows, coverage),
  };
}

export { buildGlobalReport, monthTitle, ALL, TOP_N };
