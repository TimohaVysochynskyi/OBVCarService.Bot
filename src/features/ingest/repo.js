import { jsonParam } from '../../platform/db/filters.js';
import { pool } from '../../platform/db/pool.js';
import { getState, setState } from '../../platform/db/state.js';

async function callExists(generalCallId) {
  const { rows } = await pool.query('SELECT 1 FROM calls WHERE general_call_id = $1', [generalCallId]);
  return rows.length > 0;
}

async function saveCall(call) {
  await pool.query(
    `INSERT INTO calls (general_call_id, internal_number, manager_name, start_time, duration_sec, transcript, is_success, weakest_stage, communication_score, segments, behaviors, analysis_version, call_purpose, client_number, client_name, hangup_by, audio_path, audio_bytes, audio_status, deal_blocker, deal_blocker_quote, direction, intro_name, intro_company)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     ON CONFLICT (general_call_id) DO NOTHING`,
    [
      call.generalCallId,
      call.internalNumber,
      call.managerName,
      call.startTime,
      call.durationSec,
      call.transcript,
      call.isSuccess,
      call.weakestStage,
      call.communicationScore,
      jsonParam(call.segments),
      jsonParam(call.behaviors),
      call.analysisVersion ?? null,
      call.callPurpose ?? null,
      call.clientNumber ?? null,
      call.clientName ?? null,
      call.hangupBy ?? null,
      call.audioPath ?? null,
      call.audioBytes ?? null,
      call.audioStatus ?? null,
      call.dealBlocker ?? null,
      call.dealBlockerQuote ?? null,
      call.direction ?? null,
      call.introName ?? null,
      call.introCompany ?? null,
    ]
  );
  await pool.query('DELETE FROM pending_calls WHERE general_call_id = $1', [call.generalCallId]);
}

async function getCallAudio(generalCallId) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime",
            audio_path AS "audioPath", audio_bytes AS "audioBytes", audio_status AS "audioStatus"
     FROM calls WHERE general_call_id = $1`,
    [generalCallId]
  );
  return rows[0] || null;
}

async function setCallAudio(generalCallId, { audioPath = null, audioBytes = null, audioStatus }) {
  await pool.query(
    `UPDATE calls SET audio_path = $2, audio_bytes = $3, audio_status = $4 WHERE general_call_id = $1`,
    [generalCallId, audioPath, audioBytes, audioStatus]
  );
}

async function getCallsMissingAudio({ limit = null, retryMissing = false } = {}) {
  const statusClause = retryMissing
    ? `(audio_status IS NULL OR audio_status <> 'stored')`
    : `audio_status IS NULL`;
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime",
            manager_name AS "managerName", duration_sec AS "durationSec"
     FROM calls
     WHERE audio_path IS NULL AND ${statusClause}
     ORDER BY start_time ASC
     ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

async function getAudioArchiveStats() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE audio_status = 'stored')::int AS stored,
       COUNT(*) FILTER (WHERE audio_status = 'unavailable')::int AS unavailable,
       COUNT(*) FILTER (WHERE audio_status IS NULL)::int AS untried,
       COALESCE(SUM(audio_bytes), 0)::bigint AS bytes
     FROM calls`
  );
  return rows[0];
}

async function updateDirectionIfMissing(generalCallId, direction) {
  const { rowCount } = await pool.query(
    'UPDATE calls SET direction = $2::text WHERE general_call_id = $1 AND direction IS NULL AND $2::text IS NOT NULL',
    [generalCallId, direction ?? null]
  );
  return rowCount;
}

async function getDirectionStats() {
  const { rows } = await pool.query(
    `SELECT COALESCE(direction, 'невідомо') AS direction, COUNT(*)::int AS count
     FROM calls GROUP BY 1 ORDER BY 2 DESC`
  );
  return rows;
}

async function updateClientInfoIfMissing(generalCallId, clientNumber, clientName) {
  const { rowCount } = await pool.query(
    `UPDATE calls SET
       client_number = COALESCE(client_number, $2::text),
       client_name = COALESCE(client_name, $3::text)
     WHERE general_call_id = $1
       AND ((client_number IS NULL AND $2::text IS NOT NULL) OR (client_name IS NULL AND $3::text IS NOT NULL))`,
    [generalCallId, clientNumber ?? null, clientName ?? null]
  );
  return rowCount;
}

async function getEarliestCallTime() {
  const { rows } = await pool.query('SELECT MIN(start_time) AS "min" FROM calls');
  return rows[0]?.min ?? null;
}

async function upsertPending(call, errorMessage) {
  await pool.query(
    `INSERT INTO pending_calls (general_call_id, internal_number, manager_name, start_time, duration_sec, client_number, client_name, direction, attempts, status, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'pending', $9, now())
     ON CONFLICT (general_call_id) DO UPDATE SET
       attempts = pending_calls.attempts + 1,
       last_error = $9,
       updated_at = now()`,
    [
      call.generalCallId,
      call.internalNumber,
      call.managerName,
      call.startTime,
      call.durationSec,
      call.clientNumber ?? null,
      call.clientName ?? null,
      call.direction ?? null,
      errorMessage || null,
    ]
  );
}

async function markPendingFailed(generalCallId) {
  await pool.query(`UPDATE pending_calls SET status = 'failed', updated_at = now() WHERE general_call_id = $1`, [generalCallId]);
}

async function removePendingCall(generalCallId) {
  await pool.query('DELETE FROM pending_calls WHERE general_call_id = $1', [generalCallId]);
}

async function getPendingCalls() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", internal_number AS "internalNumber", manager_name AS "managerName",
            start_time AS "startTime", duration_sec AS "durationSec", client_number AS "clientNumber",
            client_name AS "clientName", direction, attempts, last_error AS "lastError"
     FROM pending_calls
     WHERE status = 'pending'
     ORDER BY start_time`
  );
  return rows;
}

async function getCheckpoint() {
  const value = await getState('last_polled_until');
  return value ? new Date(value) : null;
}

async function setCheckpoint(date) {
  await setState('last_polled_until', date.toISOString());
}

export {
  callExists,
  saveCall,
  getCallAudio,
  setCallAudio,
  getCallsMissingAudio,
  getAudioArchiveStats,
  updateDirectionIfMissing,
  getDirectionStats,
  updateClientInfoIfMissing,
  getEarliestCallTime,
  upsertPending,
  markPendingFailed,
  removePendingCall,
  getPendingCalls,
  getCheckpoint,
  setCheckpoint,
};
