import { BLOCKED_FILTER, HAS_TEXT, NOT_BLOCKED_FILTER, SALES_FILTER, jsonParam } from '../../platform/db/filters.js';
import { NON_SALES_PURPOSES } from '../../domain/call/purpose.js';
import { pool } from '../../platform/db/pool.js';

async function updateCallAnalysis(generalCallId, { transcript, segments, behaviors, analysisVersion, callPurpose, sttMode }) {
  await pool.query(
    `UPDATE calls SET transcript = COALESCE($2, transcript),
       segments = $3::jsonb, behaviors = $4::jsonb, analysis_version = $5, call_purpose = $6,
       stt_mode = COALESCE($7, stt_mode)
     WHERE general_call_id = $1`,
    [generalCallId, transcript ?? null, jsonParam(segments), jsonParam(behaviors), analysisVersion ?? null, callPurpose ?? null, sttMode ?? null]
  );
}

async function updateCallFullAnalysis(generalCallId, { transcript, segments, behaviors, analysisVersion, callPurpose, isSuccess, weakestStage, communicationScore, introName, introCompany }) {
  await pool.query(
    `UPDATE calls SET transcript = COALESCE($2, transcript),
       segments = $3::jsonb, behaviors = $4::jsonb, analysis_version = $5, call_purpose = $6,
       is_success = $7, weakest_stage = $8, communication_score = $9,
       intro_name = COALESCE($10, intro_name), intro_company = COALESCE($11, intro_company)
     WHERE general_call_id = $1`,
    [
      generalCallId,
      transcript ?? null,
      jsonParam(segments),
      jsonParam(behaviors),
      analysisVersion ?? null,
      callPurpose ?? null,
      isSuccess ?? null,
      weakestStage ?? null,
      communicationScore ?? null,
      introName ?? null,
      introCompany ?? null,
    ]
  );
}

async function getCallsMissingIntro({ limit = null } = {}) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            internal_number AS "internalNumber", transcript, segments
     FROM calls
     WHERE intro_name IS NULL AND ${HAS_TEXT}
     ORDER BY start_time ASC${limit ? ` LIMIT ${Number(limit)}` : ''}`
  );
  return rows;
}

async function getRecentCallsForIntro(limit) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            internal_number AS "internalNumber", start_time AS "startTime", direction,
            intro_name AS "introName", intro_company AS "introCompany",
            transcript, segments
     FROM calls
     WHERE ${HAS_TEXT}
     ORDER BY start_time DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function countCallsWithText() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM calls WHERE ${HAS_TEXT}`);
  return rows[0].n;
}

async function getCallHeadsForReprocess({ limit, offset = 0 }) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", internal_number AS "internalNumber",
            call_purpose AS "callPurpose", is_success AS "isSuccess", deal_blocker AS "dealBlocker"
     FROM calls
     WHERE ${HAS_TEXT}
     ORDER BY start_time DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

async function getCallsForReprocess({ limit, offset = 0 }) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            internal_number AS "internalNumber", start_time AS "startTime",
            call_purpose AS "callPurpose", is_success AS "isSuccess", deal_blocker AS "dealBlocker",
            transcript, segments
     FROM calls
     WHERE ${HAS_TEXT}
     ORDER BY start_time DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

async function updateCallMap(generalCallId, { behaviors, analysisVersion, callPurpose, introName, introCompany }) {
  await pool.query(
    `UPDATE calls SET behaviors = $2::jsonb, analysis_version = $3, call_purpose = $4,
       intro_name = COALESCE($5, intro_name), intro_company = COALESCE($6, intro_company)
     WHERE general_call_id = $1`,
    [generalCallId, jsonParam(behaviors), analysisVersion ?? null, callPurpose ?? null, introName ?? null, introCompany ?? null]
  );
}

async function updateCallClassification(generalCallId, { isSuccess, weakestStage, communicationScore }) {
  await pool.query(
    `UPDATE calls SET is_success = $2, weakest_stage = $3, communication_score = $4
     WHERE general_call_id = $1`,
    [generalCallId, isSuccess ?? null, weakestStage ?? null, communicationScore ?? null]
  );
}

async function updateCallIntro(generalCallId, { name, company }) {
  await pool.query('UPDATE calls SET intro_name = $2, intro_company = $3 WHERE general_call_id = $1', [
    generalCallId,
    name === true,
    company === true,
  ]);
}

async function getCallsWithSegments() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            start_time AS "startTime", call_purpose AS "callPurpose", segments
     FROM calls
     WHERE segments IS NOT NULL AND jsonb_array_length(segments) >= 2
     ORDER BY start_time ASC`
  );
  return rows;
}

async function setEngineRequest(generalCallId, { isEngineRequest, service, car, quote }) {
  await pool.query(
    `UPDATE calls SET engine_request = $2, engine_service = $3, engine_car = $4, engine_quote = $5
     WHERE general_call_id = $1`,
    [generalCallId, isEngineRequest ?? null, service ?? null, car ?? null, quote ?? null]
  );
}

async function getCallsMissingEngine({ limit = null } = {}) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            start_time AS "startTime", transcript
     FROM calls
     WHERE engine_request IS NULL AND ${HAS_TEXT}
     ORDER BY start_time DESC
     ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

async function setClientComplaint(generalCallId, { hasComplaint, type, quote }) {
  await pool.query(
    `UPDATE calls SET has_complaint = $2, complaint_type = $3, complaint_quote = $4
     WHERE general_call_id = $1`,
    [generalCallId, hasComplaint ?? null, type ?? null, quote ?? null]
  );
}

async function getCallsMissingComplaint({ limit = null } = {}) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            start_time AS "startTime", transcript, segments
     FROM calls
     WHERE has_complaint IS NULL AND ${HAS_TEXT}
     ORDER BY start_time DESC
     ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

async function markSttMode(generalCallId, mode) {
  await pool.query('UPDATE calls SET stt_mode = $2 WHERE general_call_id = $1', [generalCallId, mode]);
}

async function getCallsToRetranscribe({ limit = null } = {}) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            start_time AS "startTime", direction, duration_sec AS "durationSec"
     FROM calls
     WHERE stt_mode IS NULL AND audio_path IS NOT NULL AND ${HAS_TEXT}
     ORDER BY start_time ASC
     ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

async function getSttModeStats() {
  const { rows } = await pool.query(
    `SELECT COALESCE(stt_mode, 'не позначено') AS mode, COUNT(*)::int AS count
     FROM calls WHERE ${HAS_TEXT} GROUP BY 1 ORDER BY 2 DESC`
  );
  return rows;
}

async function getCallsForRoleAudit({ limit = null, since = null } = {}) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            start_time AS "startTime", direction, audio_path AS "audioPath", segments
     FROM calls
     WHERE audio_path IS NOT NULL AND segments IS NOT NULL
       AND jsonb_array_length(segments) >= 2
       AND ($1::timestamptz IS NULL OR start_time >= $1::timestamptz)
     ORDER BY start_time ASC
     ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [since]
  );
  return rows;
}

const STALE_SCORES = `call_purpose = ANY($1)
   AND (is_success IS NOT NULL OR weakest_stage IS NOT NULL OR communication_score IS NOT NULL)`;

async function countNonSalesScores() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM calls WHERE ${STALE_SCORES}`, [NON_SALES_PURPOSES]);
  return rows[0].n;
}

async function clearNonSalesScores() {
  const { rowCount } = await pool.query(
    `UPDATE calls SET is_success = NULL, weakest_stage = NULL, communication_score = NULL
     WHERE ${STALE_SCORES}`,
    [NON_SALES_PURPOSES]
  );
  return rowCount;
}

async function applyRoleFix(generalCallId, { transcript, segments }) {
  await pool.query(
    `UPDATE calls SET transcript = $2, segments = $3::jsonb,
       behaviors = NULL, analysis_version = NULL, call_purpose = NULL,
       is_success = NULL, weakest_stage = NULL, communication_score = NULL,
       deal_blocker = NULL, deal_blocker_quote = NULL, deal_blocker_reason = NULL,
       client_decline_reason = NULL, intro_name = NULL, intro_company = NULL
     WHERE general_call_id = $1`,
    [generalCallId, transcript, jsonParam(segments)]
  );
}

async function getCallsMissingSegments() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName", direction
     FROM calls
     WHERE segments IS NULL AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time DESC`
  );
  return rows;
}

async function getCallsMissingPurpose() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName", transcript, segments
     FROM calls
     WHERE call_purpose IS NULL AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time DESC`
  );
  return rows;
}

async function getNonSalesCalls({ limit = null, onlyUnlabelled = true } = {}) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            call_purpose AS "callPurpose", transcript
     FROM calls
     WHERE call_purpose IN ('info','other'${onlyUnlabelled ? '' : ",'personal'"})
       AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time ASC
     ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

async function setCallPurpose(generalCallId, purpose) {
  await pool.query('UPDATE calls SET call_purpose = $2 WHERE general_call_id = $1', [generalCallId, purpose]);
}

async function getCallsMissingBlocker({ limit = null, relabel = false } = {}) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            call_purpose AS "callPurpose", transcript, segments
     FROM calls
     WHERE ${relabel ? BLOCKED_FILTER : 'deal_blocker IS NULL'} AND is_success IS NOT TRUE
       AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time ASC
     ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

async function getUnexplainedDeclines({ limit = null } = {}) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName", transcript
     FROM calls
     WHERE ${SALES_FILTER} AND is_success IS NOT TRUE AND ${NOT_BLOCKED_FILTER}
       AND client_decline_reason IS NULL
       AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time ASC
     ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

async function setClientDeclineReason(generalCallId, reason) {
  await pool.query('UPDATE calls SET client_decline_reason = $2 WHERE general_call_id = $1', [generalCallId, reason]);
}

async function setCallBlocker(generalCallId, { blocker, quote = null, reason = null }) {
  await pool.query(
    `UPDATE calls SET deal_blocker = $2, deal_blocker_quote = $3, deal_blocker_reason = $4 WHERE general_call_id = $1`,
    [generalCallId, blocker, quote, reason]
  );
}

async function resetAllBlockers() {
  const { rowCount } = await pool.query(
    `UPDATE calls SET deal_blocker = NULL, deal_blocker_quote = NULL WHERE deal_blocker IS NOT NULL`
  );
  return rowCount;
}

async function getRecentCallsForOperator(name, limit = 5) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime", direction,
            (segments IS NOT NULL) AS "hasSegments", analysis_version AS "analysisVersion"
     FROM calls WHERE manager_name = $1
     ORDER BY start_time DESC LIMIT $2`,
    [name, limit]
  );
  return rows;
}

async function getRecentCalls(limit = 7) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime", direction,
            manager_name AS "managerName", internal_number AS "internalNumber"
     FROM calls ORDER BY start_time DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function updateCallTranscript(generalCallId, transcript) {
  await pool.query('UPDATE calls SET transcript = $2 WHERE general_call_id = $1', [generalCallId, transcript]);
}

async function getSalesCallsWithSegments() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName", transcript, segments,
            communication_score AS "communicationScore"
     FROM calls
     WHERE call_purpose = 'sales' AND segments IS NOT NULL
       AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time`
  );
  return rows;
}

async function updateCallScore(generalCallId, score) {
  await pool.query('UPDATE calls SET communication_score = $2 WHERE general_call_id = $1', [generalCallId, score]);
}

const JOB_COLS = `id, kind, status, params, cursor, total, done, skipped, failed, error,
  chat_id AS "chatId", message_id AS "messageId", created_at AS "createdAt"`;

async function createJob({ kind, params, total, chatId, messageId }) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (kind, params, total, chat_id, message_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${JOB_COLS}`,
    [kind, jsonParam(params), total, chatId ?? null, messageId ?? null]
  );
  return rows[0];
}

async function getRunningJob() {
  const { rows } = await pool.query(`SELECT ${JOB_COLS} FROM jobs WHERE status = 'running' LIMIT 1`);
  return rows[0] || null;
}


async function saveJobProgress(id, { cursor, done, skipped, failed }) {
  const { rows } = await pool.query(
    `UPDATE jobs SET cursor = $2, done = $3, skipped = $4, failed = $5, updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING status`,
    [id, cursor, done, skipped, failed]
  );
  return rows[0]?.status === 'running';
}

async function finishJob(id, { status, error = null }) {
  await pool.query(
    `UPDATE jobs SET status = $2, error = $3, updated_at = now() WHERE id = $1 AND status = 'running'`,
    [id, status, error]
  );
}

async function cancelRunningJob() {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE status = 'running' RETURNING id`
  );
  return rows[0]?.id ?? null;
}

async function getRecentJobs(limit = 5) {
  const { rows } = await pool.query(
    `SELECT ${JOB_COLS}, updated_at AS "updatedAt" FROM jobs ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export {
  updateCallAnalysis,
  updateCallFullAnalysis,
  getCallsMissingIntro,
  getRecentCallsForIntro,
  countCallsWithText,
  getCallHeadsForReprocess,
  getCallsForReprocess,
  updateCallMap,
  updateCallClassification,
  updateCallIntro,
  getCallsWithSegments,
  setEngineRequest,
  getCallsMissingEngine,
  setClientComplaint,
  getCallsMissingComplaint,
  markSttMode,
  getCallsToRetranscribe,
  getSttModeStats,
  getCallsForRoleAudit,
  applyRoleFix,
  countNonSalesScores,
  clearNonSalesScores,
  getCallsMissingSegments,
  getCallsMissingPurpose,
  getNonSalesCalls,
  setCallPurpose,
  getCallsMissingBlocker,
  getUnexplainedDeclines,
  setClientDeclineReason,
  setCallBlocker,
  resetAllBlockers,
  getRecentCallsForOperator,
  getRecentCalls,
  updateCallTranscript,
  getSalesCallsWithSegments,
  updateCallScore,
  createJob,
  getRunningJob,
  saveJobProgress,
  finishJob,
  cancelRunningJob,
  getRecentJobs,
};
