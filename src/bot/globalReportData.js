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
  getLineBreakdown,
  getLineManagerBreakdown,
  getPurposeDirectionSplit,
  getManagerDailyTrend,
  getIntroBreakdown,
} from '../core/store.js';
import { CALL_PURPOSES } from '../core/callPurpose.js';
import { lineInfo, LINE_KINDS } from '../core/phoneLines.js';
import { BLOCKER_LABELS, BLOCKER_COLUMNS, BLOCKER_TITLES, DEAL_BLOCKERS } from '../core/dealBlocker.js';
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

const IS_LETTER = /\p{L}/u;

function withoutName(text, name) {
  if (!text || !name || !text.includes(name)) return text;
  const letter = (ch) => ch !== undefined && IS_LETTER.test(ch);
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(name, i) && !letter(text[i - 1]) && !letter(text[i + name.length])) {
      i += name.length;
      continue;
    }
    out += text[i];
    i += 1;
  }
  const stripped = out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.:;!?])/g, '$1')
    .replace(/^[\s,;:.!?—–-]+/, '')
    .trim();
  if (!stripped) return text;
  return stripped[0].toUpperCase() + stripped.slice(1);
}

function topFindings(findings, type, name) {
  return findings
    .filter((f) => f.type === type)
    .slice(0, TOP_N)
    .map((f) => ({
      claim: withoutName(f.claim, name),
      why: withoutName(f.why, name),
      action: withoutName(f.action, name),
      examples: (f.evidence || []).slice(0, TOP_N).map((e) => ({
        quote: e.quote,
        note: e.note || null,
        at: e.startTime || null,
        callId: e.callId ?? null,
        start: e.start ?? null,
        end: e.end ?? null,
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
  const to = dayEnd(start);
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

const reuseFailed = (name) => (err) => {
  console.error(`[globalReport] кеш аналізу для ${name} не прочитався: ${err.message}`);
  return null;
};

async function collectWithFallback(name, start, end, opts) {
  if (!opts.analyze) {
    const collected = await collectRangeFindings(name, start, end, { analyze: false }).catch(reuseFailed(name));
    return { collected, partial: !collected || Boolean(collected.missingDays) };
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
    const collected = await collectRangeFindings(name, start, end, { analyze: false }).catch(reuseFailed(name));
    return { collected, partial: true };
  }
}

async function managerFindings(name, start, end, opts) {
  const { collected, partial } = await collectWithFallback(name, start, end, opts);
  if (!collected?.findings?.length) {
    return { ...EMPTY_FINDINGS, analysedDays: collected?.analysedDays || 0, days: collected?.days || 0, partial };
  }

  const merged = await mergeCached(name, start, end, collected.findings);

  const display = displayName(name) || name;

  return {
    weaknesses: topFindings(merged, 'error', display),
    strengths: topFindings(merged, 'strength', display),
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
      bucketTitle: BLOCKER_TITLES[call.blocker] || call.blocker,
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
    bucketTitles: Object.fromEntries(DEAL_BLOCKERS.map((b) => [b, BLOCKER_TITLES[b]])),
    serviceTotal,
    cases,
    reasons,
    coverage,
  };
}

const emptyLine = () => ({ calls: 0, incoming: 0, outgoing: 0, sales: 0, success: 0 });

const LINE_ORDER = { shared: 0, personal: 1, other: 2 };

function closeMonths(monthsMap, months) {
  const total = emptyLine();
  for (const value of monthsMap.values()) {
    for (const key of Object.keys(total)) total[key] += value[key] || 0;
  }
  monthsMap.set(ALL, total);
  for (const m of months) if (!monthsMap.has(m)) monthsMap.set(m, emptyLine());
  return Object.fromEntries([...monthsMap.entries()]);
}

const INTRO_FIELDS = ['checked', 'checkedIn', 'checkedOut', 'withName', 'withCompany', 'withBoth', 'withNameIn', 'withNameOut'];
const emptyIntro = () => Object.fromEntries(INTRO_FIELDS.map((f) => [f, 0]));

function buildIntro(rows, months) {
  const byManager = new Map();
  for (const row of rows) {
    if (!byManager.has(row.manager)) byManager.set(row.manager, new Map());
    const monthsMap = byManager.get(row.manager);
    const bucket = monthsMap.get(row.month) || emptyIntro();
    for (const f of INTRO_FIELDS) bucket[f] += row[f] || 0;
    monthsMap.set(row.month, bucket);
  }

  const total = emptyIntro();
  const managers = [];
  for (const [name, monthsMap] of byManager) {
    const sum = emptyIntro();
    for (const bucket of monthsMap.values()) for (const f of INTRO_FIELDS) sum[f] += bucket[f];
    for (const f of INTRO_FIELDS) total[f] += sum[f];
    monthsMap.set(ALL, sum);
    for (const m of months) if (!monthsMap.has(m)) monthsMap.set(m, emptyIntro());
    managers.push({ name, display: displayName(name) || name, byMonth: Object.fromEntries([...monthsMap.entries()]), total: sum });
  }
  managers.sort((a, b) => b.total.checked - a.total.checked);
  return { managers, total };
}

function buildSeries(rows, months) {
  const byManager = new Map();

  for (const row of rows) {
    const month = String(row.day).slice(0, 7);
    if (!byManager.has(row.manager)) byManager.set(row.manager, { days: new Map(), months: new Map() });
    const acc = byManager.get(row.manager);

    const score = row.avgScore == null ? null : Number(row.avgScore);
    if (!acc.days.has(month)) acc.days.set(month, []);
    acc.days.get(month).push({
      label: String(row.day).slice(8) + '.' + String(row.day).slice(5, 7),
      sales: row.sales,
      success: row.success,
      conversion: row.reachable ? Math.round((row.success / row.reachable) * 100) : null,
      score,
    });

    const m = acc.months.get(month) || { sales: 0, success: 0, reachable: 0, scoreSum: 0, scoreN: 0 };
    m.sales += row.sales;
    m.success += row.success;
    m.reachable += row.reachable;
    if (score != null && row.sales) {
      m.scoreSum += score * row.sales;
      m.scoreN += row.sales;
    }
    acc.months.set(month, m);
  }

  const out = {};
  for (const [name, acc] of byManager) {
    const all = months
      .filter((key) => acc.months.has(key))
      .map((key) => {
        const m = acc.months.get(key);
        return {
          label: monthTitle(key).split(' ')[0].slice(0, 3),
          sales: m.sales,
          success: m.success,
          conversion: m.reachable ? Math.round((m.success / m.reachable) * 100) : null,
          score: m.scoreN ? Number((m.scoreSum / m.scoreN).toFixed(1)) : null,
        };
      });
    out[name] = { [ALL]: all };
    for (const key of months) out[name][key] = acc.days.get(key) || [];
  }
  return out;
}

const asBucket = (row) => ({
  calls: row.calls,
  incoming: row.incoming,
  outgoing: row.outgoing,
  sales: row.sales,
  success: row.success,
});

const isUnattributed = (manager, number) => manager === number;

function buildLines(rows, managerRows, months) {
  const byNumber = new Map();
  for (const row of rows) {
    if (!byNumber.has(row.number)) byNumber.set(row.number, new Map());
    byNumber.get(row.number).set(row.month, asBucket(row));
  }

  const perLine = new Map();
  for (const row of managerRows) {
    if (!perLine.has(row.number)) perLine.set(row.number, new Map());
    const managers = perLine.get(row.number);
    if (!managers.has(row.manager)) managers.set(row.manager, new Map());
    managers.get(row.manager).set(row.month, asBucket(row));

  }

  const sharedNumbers = [...byNumber.keys()].filter((n) => lineInfo(n).kind === 'shared');
  const peopleTotals = new Map();
  for (const number of sharedNumbers) {
    for (const [name, monthsMap] of perLine.get(number) || []) {
      if (isUnattributed(name, number)) continue;
      let total = peopleTotals.get(name) || 0;
      for (const bucket of monthsMap.values()) total += bucket.calls || 0;
      peopleTotals.set(name, total);
    }
  }
  const people = [...peopleTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);

  const managerTable = (number) => {
    const managers = perLine.get(number) || new Map();
    const column = (name, unknown) => ({
      name,
      display: unknown ? LINE_KINDS.unknown.title : displayName(name) || name,
      unknown,
      byMonth: closeMonths(new Map(managers.get(name) || []), months),
    });
    return [...people.map((name) => column(name, false)), column(number, true)];
  };

  const lines = [];
  for (const [number, monthsMap] of byNumber) {
    const info = lineInfo(number);
    const line = { ...info, byMonth: closeMonths(monthsMap, months) };
    if (info.kind === 'shared') line.managers = managerTable(number);
    lines.push(line);
  }

  lines.sort((a, b) => {
    const kind = LINE_ORDER[a.kind] - LINE_ORDER[b.kind];
    if (kind) return kind;
    return (b.byMonth[ALL]?.calls || 0) - (a.byMonth[ALL]?.calls || 0);
  });

  return lines;
}

function buildDirections(rows) {
  const out = {};
  for (const row of rows) {
    const purpose = CALL_PURPOSES.includes(row.purpose) ? row.purpose : 'other';
    const at = (out[purpose] ||= { incoming: 0, outgoing: 0, unknown: 0 });
    at.incoming += row.incoming;
    at.outgoing += row.outgoing;
    at.unknown += row.unknown;
  }
  return out;
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
  const [totals, purposeRows, salesRows, stageRows, blockedCalls, reasonRows, coverage, operators, lineRows, lineManagerRows, directionRows, introRows, dailyRows] =
    await Promise.all([
      getGlobalTotals(),
      getMonthlyPurposeBreakdown(),
      getMonthlySalesStats(),
      getWeakStageCounts(),
      getAllBlockedCalls(),
      getDeclineReasonCounts(),
      getDeclineCoverage(),
      getOperators(),
      getLineBreakdown(),
      getLineManagerBreakdown(),
      getPurposeDirectionSplit(),
      getIntroBreakdown(),
      getManagerDailyTrend(),
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
    lines: buildLines(lineRows, lineManagerRows, months),
    directions: buildDirections(directionRows),
    intro: buildIntro(introRows, months),
    series: buildSeries(dailyRows, months),
    managers,
    stages: [...stages.entries()].map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count),
    declines: buildDeclines(blockedCalls, reasonRows, coverage),
  };
}

export { buildGlobalReport, buildLines, buildIntro, monthTitle, ALL, TOP_N };
