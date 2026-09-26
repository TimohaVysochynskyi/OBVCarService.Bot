import { pool } from '../../platform/db/pool.js';

const PURPOSE_FILTER = { none: 'AND call_purpose IS NULL' };

function purposeClause(purpose, paramIndex) {
  if (!purpose) return { sql: '', params: [] };
  if (PURPOSE_FILTER[purpose]) return { sql: PURPOSE_FILTER[purpose], params: [] };
  return { sql: `AND call_purpose = $${paramIndex}`, params: [purpose] };
}

async function countOperatorCalls(name, purpose = null) {
  const { sql, params } = purposeClause(purpose, 2);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM calls
     WHERE manager_name = $1 AND transcript IS NOT NULL AND transcript <> '' ${sql}`,
    [name, ...params]
  );
  return rows[0].count;
}

async function listOperatorCalls(name, limit, offset, purpose = null) {
  const { sql, params } = purposeClause(purpose, 4);
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime",
            is_success AS "isSuccess", communication_score AS "communicationScore",
            call_purpose AS "callPurpose"
     FROM calls
     WHERE manager_name = $1 AND transcript IS NOT NULL AND transcript <> '' ${sql}
     ORDER BY start_time ASC
     LIMIT $2 OFFSET $3`,
    [name, limit, offset, ...params]
  );
  return rows;
}

async function getOperatorPurposeCounts(name) {
  const { rows } = await pool.query(
    `SELECT COALESCE(call_purpose, 'none') AS purpose, COUNT(*)::int AS count
     FROM calls
     WHERE manager_name = $1 AND transcript IS NOT NULL AND transcript <> ''
     GROUP BY 1`,
    [name]
  );
  const out = { sales: 0, info: 0, other: 0, none: 0 };
  for (const r of rows) if (r.purpose in out) out[r.purpose] = r.count;
  return out;
}

async function getCallByGeneralId(generalCallId) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            internal_number AS "internalNumber", start_time AS "startTime",
            duration_sec AS "durationSec", transcript, is_success AS "isSuccess",
            weakest_stage AS "weakestStage", communication_score AS "communicationScore",
            call_purpose AS "callPurpose", client_number AS "clientNumber",
            client_name AS "clientName", segments, audio_path AS "audioPath", direction
     FROM calls WHERE general_call_id = $1`,
    [generalCallId]
  );
  return rows[0] || null;
}

export {
  countOperatorCalls,
  listOperatorCalls,
  getOperatorPurposeCounts,
  getCallByGeneralId,
};
