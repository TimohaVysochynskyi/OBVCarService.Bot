import { BLOCKED_FILTER, BLOCKER_COLUMNS_SQL, HAS_TEXT, IS_PERSON, KYIV_MONTH, NOT_BLOCKED_FILTER, PERSONAL_EXTENSIONS, SALES_FILTER, jsonParam } from '../../platform/db/filters.js';
import { pool } from '../../platform/db/pool.js';
import { getState, setState } from '../../platform/db/state.js';

async function getIntroBreakdown() {
  const { rows } = await pool.query(
    `SELECT manager_name AS "manager", ${KYIV_MONTH} AS month,
            COUNT(*) FILTER (WHERE intro_name IS NOT NULL)::int AS checked,
            COUNT(*) FILTER (WHERE intro_name IS NOT NULL AND direction = 'in')::int AS "checkedIn",
            COUNT(*) FILTER (WHERE intro_name IS NOT NULL AND direction = 'out')::int AS "checkedOut",
            COUNT(*) FILTER (WHERE intro_name)::int AS "withName",
            COUNT(*) FILTER (WHERE intro_company)::int AS "withCompany",
            COUNT(*) FILTER (WHERE intro_name AND intro_company)::int AS "withBoth",
            COUNT(*) FILTER (WHERE intro_name AND direction = 'in')::int AS "withNameIn",
            COUNT(*) FILTER (WHERE intro_name AND direction = 'out')::int AS "withNameOut"
     FROM calls
     WHERE ${HAS_TEXT} AND internal_number = ANY($1)
       AND manager_name IS NOT NULL AND manager_name <> ''
     GROUP BY 1, 2`,
    [PERSONAL_EXTENSIONS]
  );
  return rows;
}

const SEGMENT_COLS = `manager_name AS "managerName", period_start AS "periodStart",
  period_end AS "periodEnd", kind, findings, phrases, stats, call_ids AS "callIds",
  candidate_count AS "candidateCount", analysis_version AS "analysisVersion", meta,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function getStoredSegment(managerName, start, end, kind) {
  const { rows } = await pool.query(
    `SELECT ${SEGMENT_COLS} FROM report_segments
     WHERE manager_name = $1 AND period_start = $2 AND period_end = $3 AND kind = $4`,
    [managerName, start, end, kind]
  );
  return rows[0] || null;
}

async function getLatestManualTail(managerName, start) {
  const { rows } = await pool.query(
    `SELECT ${SEGMENT_COLS} FROM report_segments
     WHERE manager_name = $1 AND period_start = $2 AND kind = 'manual_tail'
     ORDER BY period_end DESC LIMIT 1`,
    [managerName, start]
  );
  return rows[0] || null;
}

async function getStoredSegmentsInRange(managerName, rangeStart, rangeEnd, kinds = ['scheduled']) {
  const { rows } = await pool.query(
    `SELECT ${SEGMENT_COLS} FROM report_segments
     WHERE manager_name = $1 AND kind = ANY($4)
       AND period_start >= $2 AND period_end <= $3
     ORDER BY period_start`,
    [managerName, rangeStart, rangeEnd, kinds]
  );
  return rows;
}

async function upsertReportSegment(seg) {
  await pool.query(
    `INSERT INTO report_segments
       (manager_name, period_start, period_end, kind, findings, phrases, stats, call_ids,
        candidate_count, analysis_version, meta, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb, now())
     ON CONFLICT (manager_name, period_start, period_end, kind) DO UPDATE SET
       findings = EXCLUDED.findings, phrases = EXCLUDED.phrases, stats = EXCLUDED.stats,
       call_ids = EXCLUDED.call_ids, candidate_count = EXCLUDED.candidate_count,
       analysis_version = EXCLUDED.analysis_version, meta = EXCLUDED.meta, updated_at = now()`,
    [
      seg.managerName, seg.periodStart, seg.periodEnd, seg.kind,
      jsonParam(seg.findings ?? []), jsonParam(seg.phrases ?? []), jsonParam(seg.stats ?? null),
      jsonParam(seg.callIds ?? []), seg.candidateCount ?? null,
      seg.analysisVersion ?? 1, jsonParam(seg.meta ?? null),
    ]
  );
}

async function getCallIdsForOperator(managerName, start, end) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS id FROM calls
     WHERE manager_name = $1 AND start_time >= $2 AND start_time < $3
       AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time`,
    [managerName, start, end]
  );
  return rows.map((r) => r.id);
}

async function deleteOldManualTails(before) {
  await pool.query(
    `DELETE FROM report_segments WHERE kind = 'manual_tail' AND created_at < $1`,
    [before]
  );
}

async function getOperatorStats(name, start, end) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS "callCount",
       COUNT(*) FILTER (WHERE ${SALES_FILTER})::int AS "salesCount",
       COUNT(*) FILTER (WHERE call_purpose IN ('info','other','personal'))::int AS "infoCount",
       COUNT(*) FILTER (WHERE is_success AND ${SALES_FILTER})::int AS "successCount",
       ROUND(AVG(communication_score) FILTER (WHERE ${SALES_FILTER})::numeric, 1) AS "avgScore",
       MODE() WITHIN GROUP (ORDER BY weakest_stage) FILTER (WHERE ${SALES_FILTER} AND ${NOT_BLOCKED_FILTER}) AS "topWeakStage",${BLOCKER_COLUMNS_SQL}
       ,
       -- Introduction: counted only on this manager's OWN line, where a missing one is a service
       -- defect and not an attribution gap (core/managerIntro.js). ⚠️ The comma belongs HERE:
       -- BLOCKER_COLUMNS_SQL above deliberately ends WITHOUT one, so appending to it needs its own.
       COUNT(*) FILTER (WHERE internal_number = ANY($4) AND intro_name IS NOT NULL)::int AS "introChecked",
       COUNT(*) FILTER (WHERE internal_number = ANY($4) AND intro_name IS FALSE)::int AS "introNoName",
       COUNT(*) FILTER (WHERE internal_number = ANY($4) AND intro_company IS FALSE)::int AS "introNoCompany"
     FROM calls
     WHERE manager_name = $1 AND start_time >= $2 AND start_time < $3
       AND transcript IS NOT NULL AND transcript <> ''`,
    [name, start, end, PERSONAL_EXTENSIONS]
  );
  return rows[0];
}

async function getBlockedCalls(name, start, end) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime",
            deal_blocker AS "blocker", deal_blocker_quote AS "quote", deal_blocker_reason AS "reason",
            client_number AS "clientNumber", client_name AS "clientName"
     FROM calls
     WHERE manager_name = $1 AND start_time >= $2 AND start_time < $3 AND ${BLOCKED_FILTER}
     ORDER BY start_time ASC`,
    [name, start, end]
  );
  return rows;
}

async function getDeclineReasonCounts() {
  const { rows } = await pool.query(
    `SELECT 'service' AS side, deal_blocker_reason AS reason, COUNT(*)::int AS count
     FROM calls WHERE ${BLOCKED_FILTER} AND deal_blocker_reason IS NOT NULL
     GROUP BY deal_blocker_reason
     UNION ALL
     SELECT 'client' AS side, client_decline_reason AS reason, COUNT(*)::int AS count
     FROM calls WHERE client_decline_reason IS NOT NULL
     GROUP BY client_decline_reason
     ORDER BY count DESC`
  );
  return rows;
}

async function getGlobalTotals() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS calls,
            COALESCE(SUM(duration_sec), 0)::int AS seconds,
            MIN(start_time) AS "firstCall",
            MAX(start_time) AS "lastCall",
            COUNT(DISTINCT manager_name) FILTER (WHERE ${IS_PERSON})::int AS managers
     FROM calls WHERE ${HAS_TEXT}`
  );
  return rows[0];
}

async function getManagerDailyTrend() {
  const { rows } = await pool.query(
    `SELECT manager_name AS manager,
            to_char(start_time AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE ${SALES_FILTER})::int AS sales,
            COUNT(*) FILTER (WHERE is_success AND ${SALES_FILTER})::int AS success,
            COUNT(*) FILTER (WHERE ${SALES_FILTER} AND (${NOT_BLOCKED_FILTER} OR is_success))::int AS reachable,
            ROUND(AVG(communication_score) FILTER (WHERE ${SALES_FILTER})::numeric, 1) AS "avgScore"
     FROM calls
     WHERE ${HAS_TEXT} AND manager_name IS NOT NULL AND manager_name <> '' AND manager_name !~ '^[0-9]+$'
     GROUP BY 1, 2
     ORDER BY 2`
  );
  return rows;
}

async function getLineBreakdown() {
  const { rows } = await pool.query(
    `SELECT internal_number AS "number", ${KYIV_MONTH} AS month,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE direction = 'in')::int AS incoming,
            COUNT(*) FILTER (WHERE direction = 'out')::int AS outgoing,
            COUNT(*) FILTER (WHERE ${SALES_FILTER})::int AS sales,
            COUNT(*) FILTER (WHERE is_success AND ${SALES_FILTER})::int AS success
     FROM calls
     WHERE ${HAS_TEXT} AND internal_number IS NOT NULL AND internal_number <> ''
     GROUP BY 1, 2`
  );
  return rows;
}

async function getLineManagerBreakdown() {
  const { rows } = await pool.query(
    `SELECT internal_number AS "number", manager_name AS "manager", ${KYIV_MONTH} AS month,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE direction = 'in')::int AS incoming,
            COUNT(*) FILTER (WHERE direction = 'out')::int AS outgoing,
            COUNT(*) FILTER (WHERE ${SALES_FILTER})::int AS sales,
            COUNT(*) FILTER (WHERE is_success AND ${SALES_FILTER})::int AS success
     FROM calls
     WHERE ${HAS_TEXT} AND internal_number IS NOT NULL AND internal_number <> ''
     GROUP BY 1, 2, 3`
  );
  return rows;
}

async function getPurposeDirectionSplit() {
  const { rows } = await pool.query(
    `SELECT COALESCE(call_purpose, 'sales') AS purpose,
            COUNT(*) FILTER (WHERE direction = 'in')::int AS incoming,
            COUNT(*) FILTER (WHERE direction = 'out')::int AS outgoing,
            COUNT(*) FILTER (WHERE direction IS NULL)::int AS unknown
     FROM calls WHERE ${HAS_TEXT}
     GROUP BY 1`
  );
  return rows;
}

async function getMonthlyPurposeBreakdown() {
  const { rows } = await pool.query(
    `SELECT manager_name AS "managerName", ${KYIV_MONTH} AS month,
            COALESCE(call_purpose, 'sales') AS purpose, COUNT(*)::int AS count
     FROM calls WHERE ${HAS_TEXT}
     GROUP BY 1, 2, 3`
  );
  return rows;
}

async function getMonthlySalesStats() {
  const { rows } = await pool.query(
    `SELECT manager_name AS "managerName", ${KYIV_MONTH} AS month,
            COUNT(*) FILTER (WHERE ${SALES_FILTER})::int AS "salesCount",
            COUNT(*) FILTER (WHERE is_success AND ${SALES_FILTER})::int AS "successCount",
            COUNT(*) FILTER (WHERE ${SALES_FILTER} AND (${NOT_BLOCKED_FILTER} OR is_success))::int AS "reachableCount",
            ROUND(AVG(communication_score) FILTER (WHERE ${SALES_FILTER})::numeric, 1) AS "avgScore",
            COUNT(*) FILTER (WHERE deal_blocker = 'no_slot')::int AS "blockedNoSlot",
            COUNT(*) FILTER (WHERE deal_blocker = 'no_parts')::int AS "blockedNoParts",
            COUNT(*) FILTER (WHERE deal_blocker = 'out_of_scope')::int AS "blockedOutOfScope"
     FROM calls WHERE ${HAS_TEXT}
     GROUP BY 1, 2`
  );
  return rows;
}

async function getWeakStageCounts() {
  const { rows } = await pool.query(
    `SELECT manager_name AS "managerName", weakest_stage AS stage, COUNT(*)::int AS count
     FROM calls
     WHERE ${HAS_TEXT} AND ${SALES_FILTER} AND ${NOT_BLOCKED_FILTER} AND weakest_stage IS NOT NULL
     GROUP BY 1, 2`
  );
  return rows;
}

async function getAllBlockedCalls() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime", manager_name AS "managerName",
            deal_blocker AS blocker, deal_blocker_reason AS reason, deal_blocker_quote AS quote,
            client_number AS "clientNumber", client_name AS "clientName", is_success AS "isSuccess"
     FROM calls
     WHERE ${BLOCKED_FILTER}
     ORDER BY start_time ASC`
  );
  return rows;
}

async function getDeclineCoverage() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${SALES_FILTER} AND is_success IS NOT TRUE)::int AS "notBooked",
            COUNT(*) FILTER (WHERE ${SALES_FILTER} AND is_success IS NOT TRUE AND ${BLOCKED_FILTER})::int AS "notBookedBlocked",
            COUNT(*) FILTER (WHERE client_decline_reason IS NOT NULL)::int AS "clientExplained",
            COUNT(*) FILTER (WHERE ${SALES_FILTER} AND is_success IS NOT TRUE AND ${NOT_BLOCKED_FILTER} AND client_decline_reason IS NULL)::int AS "unchecked",
            COUNT(*) FILTER (WHERE deal_blocker IS NULL AND is_success IS NOT TRUE)::int AS "blockerUnchecked"
     FROM calls WHERE ${HAS_TEXT}`
  );
  return rows[0];
}

async function getBlockerStats() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
       -- Must match getCallsMissingBlocker exactly, transcript condition included: a call with no
       -- transcript can never be checked, and counting it as "unchecked" made a finished run report
       -- leftovers that no re-run could ever clear.
       COUNT(*) FILTER (WHERE deal_blocker IS NULL AND is_success IS NOT TRUE
                          AND transcript IS NOT NULL AND transcript <> '')::int AS unchecked,
       COUNT(*) FILTER (WHERE deal_blocker = 'none')::int AS clean,
       COUNT(*) FILTER (WHERE deal_blocker = 'no_slot')::int AS "noSlot",
       COUNT(*) FILTER (WHERE deal_blocker = 'out_of_scope')::int AS "outOfScope"
     FROM calls`
  );
  return rows[0];
}

async function getBucketedTrend(name, bucket, limit = 8) {
  const unit = bucket === 'month' ? 'month' : 'week';
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc($2, start_time AT TIME ZONE 'Europe/Kyiv'), 'YYYY-MM-DD') AS "bucketStart",
       COUNT(*)::int AS "callCount",
       COUNT(*) FILTER (WHERE ${SALES_FILTER})::int AS "salesCount",
       COUNT(*) FILTER (WHERE call_purpose IN ('info','other','personal'))::int AS "infoCount",
       COUNT(*) FILTER (WHERE is_success AND ${SALES_FILTER})::int AS "successCount",
       ROUND(AVG(communication_score) FILTER (WHERE ${SALES_FILTER})::numeric, 1) AS "avgScore",
       MODE() WITHIN GROUP (ORDER BY weakest_stage) FILTER (WHERE ${SALES_FILTER} AND ${NOT_BLOCKED_FILTER}) AS "topWeakStage",${BLOCKER_COLUMNS_SQL}
     FROM calls
     WHERE manager_name = $1 AND transcript IS NOT NULL AND transcript <> ''
     GROUP BY 1 ORDER BY 1 DESC LIMIT $3`,
    [name, unit, limit]
  );
  return rows.reverse();
}

async function getCallsForReport(name, start, end) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime",
            is_success AS "isSuccess", weakest_stage AS "weakestStage",
            communication_score AS "communicationScore", call_purpose AS "callPurpose",
            segments, behaviors
     FROM calls
     WHERE manager_name = $1 AND start_time >= $2 AND start_time < $3
       AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time`,
    [name, start, end]
  );
  return rows;
}

async function clearAllReportSegments() {
  const { rowCount } = await pool.query('DELETE FROM report_segments');
  return rowCount;
}

const DEFAULT_REPORT_TIMES = ['13:00', '19:30'];

async function getReportTimes() {
  const raw = await getState('report_times');
  if (raw == null) return [...DEFAULT_REPORT_TIMES];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [...DEFAULT_REPORT_TIMES];
  } catch {
    return [...DEFAULT_REPORT_TIMES];
  }
}

async function addReportTime(hhmm) {
  const list = await getReportTimes();
  if (list.includes(hhmm)) return list;
  list.push(hhmm);
  list.sort();
  await setState('report_times', JSON.stringify(list));
  return list;
}

async function removeReportTime(hhmm) {
  const list = (await getReportTimes()).filter((t) => t !== hhmm);
  await setState('report_times', JSON.stringify(list));
  return list;
}

async function getDeliveredSlots() {
  const raw = await getState('delivered_report_slots');
  if (raw == null) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function markSlotDelivered(slotKey) {
  const cur = await getDeliveredSlots();
  if (cur.includes(slotKey)) return;
  cur.push(slotKey);
  await setState('delivered_report_slots', JSON.stringify(cur.slice(-30)));
}

export {
  getIntroBreakdown,
  getStoredSegment,
  getLatestManualTail,
  getStoredSegmentsInRange,
  upsertReportSegment,
  getCallIdsForOperator,
  deleteOldManualTails,
  getOperatorStats,
  getBlockedCalls,
  getDeclineReasonCounts,
  getGlobalTotals,
  getManagerDailyTrend,
  getLineBreakdown,
  getLineManagerBreakdown,
  getPurposeDirectionSplit,
  getMonthlyPurposeBreakdown,
  getMonthlySalesStats,
  getWeakStageCounts,
  getAllBlockedCalls,
  getDeclineCoverage,
  getBlockerStats,
  getBucketedTrend,
  getCallsForReport,
  clearAllReportSegments,
  getReportTimes,
  addReportTime,
  removeReportTime,
  getDeliveredSlots,
  markSlotDelivered,
};
