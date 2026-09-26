import { pool } from '../../platform/db/pool.js';

async function getOperatorRoster() {
  const { rows } = await pool.query(
    `SELECT DISTINCT manager_name AS name FROM calls
     WHERE manager_name IS NOT NULL AND manager_name <> '' AND manager_name !~ '^[0-9]+$'`
  );
  return rows.map((r) => r.name);
}

async function getOperators() {
  const { rows } = await pool.query(
    `SELECT manager_name AS name, COUNT(*)::int AS n, MIN(start_time) AS "firstCall"
     FROM calls
     WHERE transcript IS NOT NULL AND transcript <> '' AND manager_name IS NOT NULL AND manager_name <> ''
     GROUP BY manager_name
     ORDER BY n DESC, manager_name`
  );
  return rows;
}

async function getActiveOperatorsInRange(start, end) {
  const { rows } = await pool.query(
    `SELECT manager_name AS name, COUNT(*)::int AS n FROM calls
     WHERE start_time >= $1 AND start_time < $2 AND transcript IS NOT NULL AND transcript <> ''
       AND manager_name IS NOT NULL AND manager_name <> '' AND manager_name !~ '^[0-9]+$'
     GROUP BY manager_name ORDER BY n DESC, manager_name`,
    [start, end]
  );
  const seen = new Set(rows.map((r) => r.name));
  for (const name of Object.values(PERSONAL_OPERATORS)) {
    if (!seen.has(name)) rows.push({ name, n: 0 });
  }
  return rows;
}

async function getNumericManagerCalls() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", internal_number AS "internalNumber",
            manager_name AS "managerName", transcript
     FROM calls
     WHERE manager_name ~ '^[0-9]+$' AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time`
  );
  return rows;
}

async function updateManagerName(generalCallId, managerName) {
  await pool.query('UPDATE calls SET manager_name = $2 WHERE general_call_id = $1', [generalCallId, managerName]);
}

async function reassignCallsByExtension(internalNumber, managerName) {
  const { rowCount } = await pool.query('UPDATE calls SET manager_name = $2 WHERE internal_number = $1', [internalNumber, managerName]);
  return rowCount;
}

async function renameManagerEverywhere(oldName, newName) {
  const { rowCount } = await pool.query('UPDATE calls SET manager_name = $2 WHERE manager_name = $1', [oldName, newName]);
  return rowCount;
}

async function deleteCallsByExtension(internalNumber) {
  const { rowCount } = await pool.query('DELETE FROM calls WHERE internal_number = $1', [internalNumber]);
  await pool.query('DELETE FROM pending_calls WHERE internal_number = $1', [internalNumber]);
  return rowCount;
}

export {
  getOperatorRoster,
  getOperators,
  getActiveOperatorsInRange,
  getNumericManagerCalls,
  updateManagerName,
  reassignCallsByExtension,
  renameManagerEverywhere,
  deleteCallsByExtension,
};
