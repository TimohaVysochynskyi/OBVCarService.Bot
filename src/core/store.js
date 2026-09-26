import pg from 'pg';
import { PERSONAL_OPERATORS } from './phoneLines.js';

const { Pool } = pg;

function sslConfig() {
  const url = process.env.DATABASE_URL || '';
  if (/\bsslmode=disable\b/i.test(url)) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url)) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
});

let poolErrorHandler = null;
pool.on('error', (err) => {
  console.error(`[store] помилка простійного підключення до Postgres: ${err.message}`);
  if (!poolErrorHandler) return;
  try {
    poolErrorHandler(err);
  } catch (inner) {
    console.error(`[store] обробник помилки пулу впав: ${inner.message}`);
  }
});

function onPoolError(handler) {
  poolErrorHandler = handler;
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      general_call_id TEXT UNIQUE NOT NULL,
      internal_number TEXT,
      manager_name TEXT,
      start_time TIMESTAMPTZ,
      duration_sec INTEGER,
      transcript TEXT,
      is_success BOOLEAN,
      weakest_stage TEXT,
      communication_score INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE calls ADD COLUMN IF NOT EXISTS is_success BOOLEAN;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS weakest_stage TEXT;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS communication_score INTEGER;

    -- Evidence-first analysis (see src/core/analyzeCall.js + src/bot/analyze.js). Computed ONCE
    -- per call at ingest and cached, so per-period reports (day/week/month/quarter) only aggregate
    -- stored data instead of re-analysing every transcript.
    --   segments: the diarized dialogue WITH per-turn timecodes — [{role,text,start,end}] — kept so
    --     we can cut audio clips around a quoted line (ElevenLabs words[] give start/end; the plain
    --     transcript string still holds the same dialogue for the instant archive view). NULL for
    --     the OpenAI fallback path (no diarization/timecodes) and for calls ingested before this.
    --   behaviors: the per-call map — {version, items:[{type,stage,label,quote,start,end,segIndex}]}
    --     where each item is a tagged strength/error with a verbatim manager quote and (when the
    --     quote was located in segments) its timecode. The report "reduce" pulls these and clusters
    --     them into evidence-backed findings.
    --   analysis_version: lets a future taxonomy change trigger a re-map (backfill) of old rows.
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS segments JSONB;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS behaviors JSONB;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS analysis_version INTEGER;
    -- call_purpose: 'sales' | 'info' | 'other' (decided by the per-call MAP). Only 'sales' calls
    -- feed the sales-effectiveness findings; the report shows a sales-vs-info numeric breakdown and
    -- computes conversion over sales calls only. NULL for rows not yet (re)analysed → treated as
    -- sales-relevant for backward-compat until the analysis backfill fills them.
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_purpose TEXT;
    -- The CLIENT's raw phone number (Binotel externalNumber), NOT ours. Was never captured before
    -- 2026-07-24 (bug: the archive call-detail screen had no client number to show at all, only the
    -- internal call id, which reads confusingly like a phone number). NULL on rows ingested before
    -- this - see src/scripts/backfillClientNumbers.js for the one-off historical backfill.
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS client_number TEXT;

    -- Whoever the client is labelled as, per Binotel's CRM integration (customerDataFromOutside.name;
    -- Binotel's own customerData is empty on this account). NULL = unlabelled caller, shown as
    -- "Невідомо". CRM placeholders ("New client 0973127982") are normalised to NULL at ingest, see
    -- core/binotel.js: extractClientName. Backfilled by src/scripts/backfillClientNumbers.js.
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS client_name TEXT;

    -- Who ended the call (Binotel whoHungUp). Captured but UNUSED: verified empty on 458 calls over
    -- 30 days on this account (see core/binotel.js), so nothing is judged on it yet. The column
    -- exists so that real values start accumulating the moment Binotel populates the field.
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS hangup_by TEXT;

    -- "Незакриті угоди" (src/core/dealBlocker.js): the deal did not close because the СТО itself
    -- could not take the job, NOT because the manager mishandled it.
    --   deal_blocker       — 'no_slot' (temporarily full) | 'out_of_scope' (we never do this) |
    --                        'none' (checked, no blocker). NULL = not checked yet, which is what the
    --                        blocker backfill selects on.
    --   deal_blocker_quote — the VERBATIM manager line that states the constraint, re-verified in code
    --                        against the call's manager segments; without it the blocker is discarded.
    -- Blocked calls are excluded from the conversion denominator and from the weakest-stage mode, so a
    -- manager is not scored down for business the service could not accept.
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS deal_blocker TEXT;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS deal_blocker_quote TEXT;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS deal_blocker_reason TEXT;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS client_decline_reason TEXT;

    -- Local audio archive (src/core/audioStore.js). Recordings used to be streamed from Binotel to
    -- the transcriber and dropped; the client requires them KEPT, so the ingest now saves each file
    -- on the VPS and records where.
    --   audio_path   — path RELATIVE to the storage root ("2026-07/6747512562.mp3"). NULL = not stored.
    --   audio_bytes  — size of the stored file (lets us report archive size / spot truncation).
    --   audio_status — 'stored' | 'unavailable'. NULL means "never attempted", which is what the
    --                  audio backfill (src/scripts/backfillAudio.js) selects on; 'unavailable' means
    --                  we asked Binotel and it has no recording, so the row is skipped on re-runs
    --                  instead of retrying forever — but it stays visible, nothing is lost silently.
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS audio_path TEXT;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS audio_bytes INTEGER;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS audio_status TEXT;

    CREATE TABLE IF NOT EXISTS pending_calls (
      general_call_id TEXT PRIMARY KEY,
      internal_number TEXT,
      manager_name TEXT,
      start_time TIMESTAMPTZ,
      duration_sec INTEGER,
      client_number TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE pending_calls ADD COLUMN IF NOT EXISTS client_number TEXT;
    ALTER TABLE pending_calls ADD COLUMN IF NOT EXISTS client_name TEXT;

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Persisted analytics results per (manager × time segment). The report "reduce" (the costly LLM
    -- clustering into findings) is cached here so a segment is analysed ONCE and frozen: repeated
    -- "Звіт зараз", the daily auto-reports and incremental reports all REUSE it instead of
    -- re-analysing from scratch. Two kinds:
    --   'scheduled'   — a canonical day-bounded segment [prev boundary, slot]/[slot, midnight]. These
    --                   are the immutable time series used to track a manager's growth over time.
    --   'manual_tail' — an ephemeral tail [last boundary, "now"] computed for a manual "Звіт зараз";
    --                   deduped by call_ids so a double-click reuses it, GC'd later.
    -- call_ids = the general_call_ids that fed the analysis (change detection / late-call self-heal).
    -- meta = {rubricHash, promptHash, model, passes} — what logic/config produced this snapshot.
    CREATE TABLE IF NOT EXISTS report_segments (
      id SERIAL PRIMARY KEY,
      manager_name TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      kind TEXT NOT NULL,
      findings JSONB NOT NULL DEFAULT '[]',
      phrases JSONB NOT NULL DEFAULT '[]',
      stats JSONB,
      call_ids JSONB NOT NULL DEFAULT '[]',
      candidate_count INTEGER,
      analysis_version INTEGER NOT NULL DEFAULT 1,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS report_segments_uq
      ON report_segments (manager_name, period_start, period_end, kind);
    CREATE INDEX IF NOT EXISTS report_segments_lookup
      ON report_segments (manager_name, kind, period_start);

    -- manager_notes (per-operator free-text notes) removed by request - the feature is gone from
    -- the bot entirely, not just hidden. DROP is idempotent (no-op once applied).
    DROP TABLE IF EXISTS manager_notes;

    -- One-time cleanup of pre-refactor artifacts. Binotel is now the source of truth for
    -- operators (see identifyManager / resolveManagerName), so the local managers table and
    -- the manager_id foreign key are gone; attribution keys off calls.manager_name only.
    -- Guarded with IF EXISTS => a no-op once applied. The column was 100% NULL before removal,
    -- so no data is lost.
    ALTER TABLE calls DROP COLUMN IF EXISTS manager_id;
    DROP TABLE IF EXISTS managers;

    -- call_type (incoming/outgoing marker from Binotel) removed by request — dropped from all rows
    -- (new and old). Idempotent: a no-op once applied.
    ALTER TABLE calls DROP COLUMN IF EXISTS call_type;
    ALTER TABLE pending_calls DROP COLUMN IF EXISTS call_type;
    -- direction: 'in' | 'out' (core/callDirection.js), from Binotel's callType.
    -- ⚠️ Deliberately NOT named call_type: the two ALTERs above still drop that legacy column on
    -- every migrate, so a column with that name would be deleted on the next boot.
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS direction TEXT;
    ALTER TABLE pending_calls ADD COLUMN IF NOT EXISTS direction TEXT;

    -- Did the manager introduce himself: his own name, and the service's name (core/managerIntro.js).
    -- Two columns rather than one JSONB field because the whole point of them is to be COUNTED per
    -- manager and per month. NULL = not decided yet, which is exactly what the backfill selects on.
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS intro_name BOOLEAN;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS intro_company BOOLEAN;

    -- Historical rows from before the 4-stage taxonomy was unified (Задача 2, 2026-07-23) can carry
    -- the short pre-unification label "закриття" instead of the canonical "закриття угоди"
    -- (core/stages.js: SALES_STAGES) - classifyCall's schema enum has only ever allowed the full
    -- name since the unification, so this is purely a historical-data fix. Idempotent: a no-op once
    -- applied (no row will match "закриття" again afterwards).
    UPDATE calls SET weakest_stage = 'закриття угоди' WHERE weakest_stage = 'закриття';

    -- Bot access control (role system). Purely for AUTHORIZING who may use the bot and which
    -- features they see — NOT a revival of the old attribution "managers" table (Binotel stays
    -- the source of truth for who spoke on a call). role: director|marketer|manager|mechanic.
    -- telegram_id is NULL for a "pending" invite (added by phone before the person opened the
    -- bot); it's filled and status flips to 'active' when they share their contact. operator_name
    -- links a manager row to calls.manager_name so they can see their own stats.
    CREATE TABLE IF NOT EXISTS bot_users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      role TEXT NOT NULL,
      phone TEXT,
      username TEXT,
      display_name TEXT,
      operator_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      added_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Journal of incidents. Written by BOTH processes (core/errorLog.js), read by the bot's /log
    -- screen. The point is not observability for its own sake: without it the client could tell a
    -- developer nothing but "it does not work", and the developer had to SSH into the VPS and grep
    -- 20k lines of pm2 log by approximate time. The incident column holds the 4-character id the
    -- person sees in the error message, so a forwarded screenshot is enough to find the row.
    --   process   — 'bot' | 'poll' (which of the two pm2 processes hit it)
    --   feature   — which action failed (the ACTIONS key from core/errorTexts.js)
    --   technical — the full dump: service, HTTP status, response body, stack
    --   context   — anything specific to the site (call id, manager, file name)
    CREATE TABLE IF NOT EXISTS error_log (
      id SERIAL PRIMARY KEY,
      incident TEXT NOT NULL,
      code TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      process TEXT NOT NULL,
      feature TEXT,
      telegram_id BIGINT,
      message TEXT,
      technical TEXT,
      context JSONB
    );
    CREATE INDEX IF NOT EXISTS error_log_at_idx ON error_log (at DESC);
    CREATE INDEX IF NOT EXISTS error_log_incident_idx ON error_log (incident);
    CREATE INDEX IF NOT EXISTS error_log_code_idx ON error_log (code, at DESC);

    -- One-time reset of the legacy PROSE analysis prompt. The report was rewritten to an
    -- evidence-first pipeline (analyze.js), so an old stored prose prompt would be stale guidance.
    -- Guarded by a marker key => runs at most once; the owner can re-customize via /prompt after.
    DELETE FROM app_state WHERE key = 'analyze_prompt'
      AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = 'analyze_prompt_v2');
    INSERT INTO app_state (key, value) VALUES ('analyze_prompt_v2', '1')
      ON CONFLICT (key) DO NOTHING;
  `);
}


const BOT_USER_COLS = `id, telegram_id AS "telegramId", role, phone, username,
  display_name AS "displayName", operator_name AS "operatorName", status`;

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

async function getBotUser(telegramId) {
  const { rows } = await pool.query(
    `SELECT ${BOT_USER_COLS} FROM bot_users WHERE telegram_id = $1`,
    [telegramId]
  );
  return rows[0] || null;
}

async function getBotUserById(id) {
  const { rows } = await pool.query(`SELECT ${BOT_USER_COLS} FROM bot_users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getBotUsersByRole(role) {
  const { rows } = await pool.query(
    `SELECT ${BOT_USER_COLS} FROM bot_users WHERE role = $1 ORDER BY status, display_name NULLS LAST, id`,
    [role]
  );
  return rows;
}

async function upsertBotUserByTelegram({ telegramId, role, phone, username, displayName, operatorName, addedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO bot_users (telegram_id, role, phone, username, display_name, operator_name, status, added_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
     ON CONFLICT (telegram_id) DO UPDATE SET
       role = $2,
       phone = COALESCE($3, bot_users.phone),
       username = COALESCE($4, bot_users.username),
       display_name = COALESCE($5, bot_users.display_name),
       operator_name = COALESCE($6, bot_users.operator_name),
       status = 'active'
     RETURNING id`,
    [telegramId, role, phone ? normalizePhone(phone) : null, username || null, displayName || null, operatorName || null, addedBy || null]
  );
  return rows[0].id;
}

async function addPendingBotUser({ phone, role, displayName, addedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO bot_users (telegram_id, role, phone, display_name, status, added_by)
     VALUES (NULL, $2, $1, $3, 'pending', $4) RETURNING id`,
    [normalizePhone(phone), role, displayName || null, addedBy || null]
  );
  return rows[0].id;
}

async function activatePendingByPhone(phone, { telegramId, username, displayName }) {
  const { rows } = await pool.query(
    `UPDATE bot_users SET telegram_id = $2, username = COALESCE($3, username),
       display_name = COALESCE($4, display_name), status = 'active'
     WHERE status = 'pending' AND telegram_id IS NULL
       AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 9) = RIGHT($1, 9)
     RETURNING id, role`,
    [normalizePhone(phone), telegramId, username || null, displayName || null]
  );
  return rows[0] || null;
}

async function setBotUserOperator(id, operatorName) {
  await pool.query('UPDATE bot_users SET operator_name = $2 WHERE id = $1', [id, operatorName]);
}

async function setBotUserPhone(telegramId, phone) {
  await pool.query('UPDATE bot_users SET phone = $2 WHERE telegram_id = $1', [telegramId, normalizePhone(phone)]);
}

async function deleteBotUser(id) {
  const { rows } = await pool.query('DELETE FROM bot_users WHERE id = $1 RETURNING telegram_id AS "telegramId", role', [id]);
  return rows[0] || null;
}

async function seedDirector(telegramId) {
  await pool.query(
    `INSERT INTO bot_users (telegram_id, role, display_name, status)
     VALUES ($1, 'director', 'Директор', 'active')
     ON CONFLICT (telegram_id) DO NOTHING`,
    [telegramId]
  );
}

async function callExists(generalCallId) {
  const { rows } = await pool.query('SELECT 1 FROM calls WHERE general_call_id = $1', [generalCallId]);
  return rows.length > 0;
}

const jsonParam = (v) => (v == null ? null : JSON.stringify(v));

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

async function updateCallAnalysis(generalCallId, { transcript, segments, behaviors, analysisVersion, callPurpose }) {
  await pool.query(
    `UPDATE calls SET transcript = COALESCE($2, transcript),
       segments = $3::jsonb, behaviors = $4::jsonb, analysis_version = $5, call_purpose = $6
     WHERE general_call_id = $1`,
    [generalCallId, transcript ?? null, jsonParam(segments), jsonParam(behaviors), analysisVersion ?? null, callPurpose ?? null]
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


const PERSONAL_EXTENSIONS = Object.keys(PERSONAL_OPERATORS);

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

async function getCallsMissingSegments() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName"
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

const SALES_FILTER = `(call_purpose = 'sales' OR call_purpose IS NULL)`;

const BLOCKED_FILTER = `deal_blocker IN ('no_slot','no_parts','out_of_scope')`;
const NOT_BLOCKED_FILTER = `(deal_blocker IS NULL OR deal_blocker NOT IN ('no_slot','no_parts','out_of_scope'))`;

const BLOCKER_COLUMNS_SQL = `
       COUNT(*) FILTER (WHERE ${SALES_FILTER} AND (${NOT_BLOCKED_FILTER} OR is_success))::int AS "reachableCount",
       COUNT(*) FILTER (WHERE ${BLOCKED_FILTER})::int AS "blockedCount",
       COUNT(*) FILTER (WHERE deal_blocker = 'no_slot')::int AS "blockedNoSlot",
       COUNT(*) FILTER (WHERE deal_blocker = 'no_parts')::int AS "blockedNoParts",
       COUNT(*) FILTER (WHERE deal_blocker = 'out_of_scope')::int AS "blockedOutOfScope"`;

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

const HAS_TEXT = `transcript IS NOT NULL AND transcript <> ''`;
const KYIV_MONTH = `to_char(start_time AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM')`;
const IS_PERSON = `manager_name !~ '^[0-9]+$'`;

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

async function getRecentCallsForOperator(name, limit = 5) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime",
            (segments IS NOT NULL) AS "hasSegments", analysis_version AS "analysisVersion"
     FROM calls WHERE manager_name = $1
     ORDER BY start_time DESC LIMIT $2`,
    [name, limit]
  );
  return rows;
}

async function getRecentCalls(limit = 7) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime",
            manager_name AS "managerName", internal_number AS "internalNumber"
     FROM calls ORDER BY start_time DESC LIMIT $1`,
    [limit]
  );
  return rows;
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

async function updateCallTranscript(generalCallId, transcript) {
  await pool.query('UPDATE calls SET transcript = $2 WHERE general_call_id = $1', [generalCallId, transcript]);
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

async function getCallsWithTranscriptsInRange(start, end) {
  const { rows } = await pool.query(
    `SELECT manager_name AS "managerName", internal_number AS "internalNumber", transcript,
            start_time AS "startTime", is_success AS "isSuccess",
            weakest_stage AS "weakestStage", communication_score AS "communicationScore"
     FROM calls
     WHERE start_time >= $1 AND start_time < $2 AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY manager_name, start_time`,
    [start, end]
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

async function clearAllReportSegments() {
  const { rowCount } = await pool.query('DELETE FROM report_segments');
  return rowCount;
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

async function setHeartbeat(name, when = new Date()) {
  await setState(`heartbeat_${name}`, when.toISOString());
}

async function getHeartbeat(name) {
  const raw = await getState(`heartbeat_${name}`);
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}


async function insertErrorLog(entry) {
  await pool.query(
    `INSERT INTO error_log (incident, code, process, feature, telegram_id, message, technical, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.incident,
      entry.code,
      entry.process,
      entry.feature ?? null,
      entry.telegramId ?? null,
      entry.message ?? null,
      entry.technical ?? null,
      entry.context ? JSON.stringify(entry.context) : null,
    ]
  );
}

function mapErrorRow(row) {
  return {
    id: row.id,
    incident: row.incident,
    code: row.code,
    at: row.at,
    process: row.process,
    feature: row.feature,
    telegramId: row.telegram_id,
    message: row.message,
    technical: row.technical,
    context: row.context,
  };
}

async function listErrorLog(limit = 10, { code = null } = {}) {
  const { rows } = code
    ? await pool.query('SELECT * FROM error_log WHERE code = $1 ORDER BY at DESC LIMIT $2', [code, limit])
    : await pool.query('SELECT * FROM error_log ORDER BY at DESC LIMIT $1', [limit]);
  return rows.map(mapErrorRow);
}

async function getErrorLogByIncident(incident) {
  const { rows } = await pool.query(
    'SELECT * FROM error_log WHERE incident = $1 ORDER BY at DESC LIMIT 1',
    [incident]
  );
  return rows[0] ? mapErrorRow(rows[0]) : null;
}

async function summarizeErrorLog(since) {
  const { rows } = await pool.query(
    `SELECT code, COUNT(*)::int AS "count", MAX(at) AS "lastAt"
       FROM error_log WHERE at >= $1
      GROUP BY code ORDER BY MAX(at) DESC`,
    [since]
  );
  return rows;
}

async function deleteOldErrorLog(before) {
  const { rowCount } = await pool.query('DELETE FROM error_log WHERE at < $1', [before]);
  return rowCount;
}

async function getEarliestCallTime() {
  const { rows } = await pool.query('SELECT MIN(start_time) AS "min" FROM calls');
  return rows[0]?.min ?? null;
}


async function migrateKb() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_docs (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      uploaded_by TEXT,
      file_id TEXT,
      mime TEXT,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Telegram file_id lets us resend the original document ("open file") without storing bytes.
    ALTER TABLE kb_docs ADD COLUMN IF NOT EXISTS file_id TEXT;
    ALTER TABLE kb_docs ADD COLUMN IF NOT EXISTS mime TEXT;

    -- Audience = which employee role a manual is FOR: 'mechanic' | 'manager' | 'both'. Filters KB
    -- answers so a mechanic never gets a manager's sales manual and vice versa (director/marketer
    -- see everything). NOT NULL DEFAULT 'mechanic' also backfills pre-existing rows to 'mechanic'
    -- (per the client's request that current files belong to mechanics).
    ALTER TABLE kb_docs ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'mechanic';

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id SERIAL PRIMARY KEY,
      doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding vector(1536),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops);

    -- Page range a chunk came from (PDF only; NULL for DOCX/TXT which have no pages). Lets a KB
    -- answer cite the exact page(s). Chunks ingested before this column stay NULL (no page shown).
    ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS page_start INTEGER;
    ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS page_end INTEGER;

    -- Lexical half of the hybrid search. Vector search alone misses exact technical terms (a part
    -- name, a spec number) because the embedding smears them into the surrounding topic; FTS nails
    -- them. Config is 'simple' (no Ukrainian stemmer ships with Postgres) — morphology is handled by
    -- turning query words into prefix terms (двигун:*), see searchKbChunksLexical.
    ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
    CREATE INDEX IF NOT EXISTS kb_chunks_tsv_idx ON kb_chunks USING gin (tsv);
  `);
}

const vecToStr = (arr) => `[${arr.join(',')}]`;

async function insertKbDoc(filename, uploadedBy, fileId, mime, audience = 'mechanic') {
  const { rows } = await pool.query(
    'INSERT INTO kb_docs (filename, uploaded_by, file_id, mime, audience) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [filename, uploadedBy || null, fileId || null, mime || null, audience]
  );
  return rows[0].id;
}

const CHUNK_INSERT_BATCH = 100;

async function insertChunkRows(client, docId, chunks) {
  for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
    const batch = chunks.slice(i, i + CHUNK_INSERT_BATCH);
    const values = [];
    const params = [];
    for (const c of batch) {
      const n = params.length;
      values.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}::vector, $${n + 5}, $${n + 6})`);
      params.push(docId, c.ord, c.content, vecToStr(c.embedding), c.pageStart ?? null, c.pageEnd ?? null);
    }
    await client.query(
      `INSERT INTO kb_chunks (doc_id, ord, content, embedding, page_start, page_end) VALUES ${values.join(', ')}`,
      params
    );
  }
  await client.query('UPDATE kb_docs SET chunk_count = $2 WHERE id = $1', [docId, chunks.length]);
}

async function insertKbChunks(docId, chunks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertChunkRows(client, docId, chunks);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function replaceKbDocChunks(docId, chunks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM kb_chunks WHERE doc_id = $1', [docId]);
    await insertChunkRows(client, docId, chunks);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function searchKbChunks(queryEmbedding, k = 6, audiences = null) {
  const params = [vecToStr(queryEmbedding), k];
  let filter = '';
  if (audiences && audiences.length) {
    params.push(audiences);
    filter = `WHERE d.audience = ANY($3)`;
  }
  const { rows } = await pool.query(
    `SELECT c.id AS "chunkId", c.content, c.page_start AS "pageStart", c.page_end AS "pageEnd",
            d.filename, d.id AS "docId", (c.embedding <=> $1::vector) AS dist
     FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
     ${filter}
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    params
  );
  return rows;
}

async function searchKbChunksLexical(tsQuery, k = 12, audiences = null) {
  const params = [tsQuery, k];
  let filter = '';
  if (audiences && audiences.length) {
    params.push(audiences);
    filter = 'AND d.audience = ANY($3)';
  }
  const { rows } = await pool.query(
    `SELECT c.id AS "chunkId", c.content, c.page_start AS "pageStart", c.page_end AS "pageEnd",
            d.filename, d.id AS "docId", ts_rank_cd(c.tsv, q) AS score
     FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id, to_tsquery('simple', $1) q
     WHERE c.tsv @@ q ${filter}
     ORDER BY score DESC
     LIMIT $2`,
    params
  );
  return rows;
}

async function listKbDocs() {
  const { rows } = await pool.query(
    `SELECT id, filename, chunk_count AS "chunkCount", audience, created_at AS "createdAt"
     FROM kb_docs ORDER BY created_at DESC`
  );
  return rows;
}

async function countKbChunks() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM kb_chunks');
  return rows[0].n;
}

async function getKbDoc(id) {
  const { rows } = await pool.query(
    `SELECT id, filename, file_id AS "fileId", mime, chunk_count AS "chunkCount", audience, created_at AS "createdAt"
     FROM kb_docs WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function getKbDocsWithFile() {
  const { rows } = await pool.query(
    `SELECT id, filename, file_id AS "fileId", mime, audience, chunk_count AS "chunkCount"
     FROM kb_docs WHERE file_id IS NOT NULL ORDER BY id`
  );
  return rows;
}

async function setKbDocAudience(id, audience) {
  await pool.query('UPDATE kb_docs SET audience = $2 WHERE id = $1', [id, audience]);
}

async function deleteKbDoc(id) {
  await pool.query('DELETE FROM kb_docs WHERE id = $1', [id]);
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


async function getState(key) {
  const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function setState(key, value) {
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
}

async function deleteState(key) {
  await pool.query('DELETE FROM app_state WHERE key = $1', [key]);
}

async function getStoredAnalyzePrompt() {
  return getState('analyze_prompt');
}

async function setStoredAnalyzePrompt(text) {
  await setState('analyze_prompt', text);
}

async function clearStoredAnalyzePrompt() {
  await deleteState('analyze_prompt');
}

async function getStoredScoreRubric() {
  return getState('score_rubric');
}

async function setStoredScoreRubric(text) {
  await setState('score_rubric', text);
}

async function clearStoredScoreRubric() {
  await deleteState('score_rubric');
}

async function getRecipients(kind) {
  const raw = await getState(`${kind}_recipients`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function addRecipient(kind, { id, name }) {
  const list = await getRecipients(kind);
  const sid = String(id);
  if (list.some((r) => String(r.id) === sid)) return list;
  list.push({ id: sid, name: name || sid });
  await setState(`${kind}_recipients`, JSON.stringify(list));
  return list;
}

async function removeRecipient(kind, id) {
  const sid = String(id);
  const list = (await getRecipients(kind)).filter((r) => String(r.id) !== sid);
  await setState(`${kind}_recipients`, JSON.stringify(list));
  return list;
}

async function getCheckpoint() {
  const value = await getState('last_polled_until');
  return value ? new Date(value) : null;
}

async function setCheckpoint(date) {
  await setState('last_polled_until', date.toISOString());
}

async function getReportSlot() {
  return getState('last_report_slot');
}

async function setReportSlot(slotKey) {
  await setState('last_report_slot', slotKey);
}

async function getReportUntil() {
  const value = await getState('last_report_until');
  return value ? new Date(value) : null;
}

async function setReportUntil(date) {
  await setState('last_report_until', date.toISOString());
}

const DEFAULT_REPORT_TIMES = ['13:00', '19:30'];

async function pingDb() {
  await pool.query('SELECT 1');
  return true;
}

async function getAlertState(key) {
  const raw = await getState(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function setAlertState(key, state) {
  await setState(key, JSON.stringify(state));
}

async function clearAlertState(key) {
  await deleteState(key);
}

async function clearAlertStates(prefix) {
  const { rowCount } = await pool.query('DELETE FROM app_state WHERE key LIKE $1', [`${prefix}%`]);
  return rowCount;
}

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
  migrate,
  callExists,
  saveCall,
  getOperatorRoster,
  getOperators,
  getOperatorStats,
  getBucketedTrend,
  getCallsForReport,
  getRecentCalls,
  getRecentCallsForOperator,
  updateCallTranscript,
  updateCallAnalysis,
  updateCallFullAnalysis,
  getCallsMissingIntro,
  getRecentCallsForIntro,
  countCallsWithText,
  getCallsForReprocess,
  getCallHeadsForReprocess,
  updateCallMap,
  updateCallClassification,
  updateCallIntro,
  getIntroBreakdown,
  getCallsMissingSegments,
  getCallsMissingPurpose,
  getGlobalTotals,
  getMonthlyPurposeBreakdown,
  getLineBreakdown,
  getManagerDailyTrend,
  getLineManagerBreakdown,
  getPurposeDirectionSplit,
  getMonthlySalesStats,
  getWeakStageCounts,
  getAllBlockedCalls,
  getDeclineCoverage,
  getUnexplainedDeclines,
  setClientDeclineReason,
  getDeclineReasonCounts,
  getNonSalesCalls,
  setCallPurpose,
  getStoredSegment,
  getLatestManualTail,
  getStoredSegmentsInRange,
  upsertReportSegment,
  getCallIdsForOperator,
  deleteOldManualTails,
  countOperatorCalls,
  listOperatorCalls,
  getOperatorPurposeCounts,
  getCallByGeneralId,
  getCallsWithTranscriptsInRange,
  getActiveOperatorsInRange,
  getNumericManagerCalls,
  updateManagerName,
  reassignCallsByExtension,
  renameManagerEverywhere,
  deleteCallsByExtension,
  clearAllReportSegments,
  updateClientInfoIfMissing,
  updateDirectionIfMissing,
  getDirectionStats,
  getSalesCallsWithSegments,
  updateCallScore,
  getBlockedCalls,
  getCallsMissingBlocker,
  setCallBlocker,
  getBlockerStats,
  resetAllBlockers,
  getCallAudio,
  setCallAudio,
  getCallsMissingAudio,
  getAudioArchiveStats,
  getEarliestCallTime,
  migrateKb,
  insertKbDoc,
  insertKbChunks,
  replaceKbDocChunks,
  searchKbChunks,
  searchKbChunksLexical,
  listKbDocs,
  countKbChunks,
  getKbDoc,
  getKbDocsWithFile,
  setKbDocAudience,
  deleteKbDoc,
  upsertPending,
  markPendingFailed,
  removePendingCall,
  getPendingCalls,
  getCheckpoint,
  setCheckpoint,
  getReportSlot,
  setReportSlot,
  getReportUntil,
  setReportUntil,
  getReportTimes,
  addReportTime,
  removeReportTime,
  getDeliveredSlots,
  markSlotDelivered,
  pingDb,
  getAlertState,
  setAlertState,
  clearAlertState,
  clearAlertStates,
  onPoolError,
  setHeartbeat,
  getHeartbeat,
  insertErrorLog,
  listErrorLog,
  getErrorLogByIncident,
  summarizeErrorLog,
  deleteOldErrorLog,
  getState,
  setState,
  deleteState,
  getStoredAnalyzePrompt,
  setStoredAnalyzePrompt,
  clearStoredAnalyzePrompt,
  getStoredScoreRubric,
  setStoredScoreRubric,
  clearStoredScoreRubric,
  getRecipients,
  addRecipient,
  removeRecipient,
  normalizePhone,
  getBotUser,
  getBotUserById,
  getBotUsersByRole,
  upsertBotUserByTelegram,
  addPendingBotUser,
  activatePendingByPhone,
  setBotUserOperator,
  setBotUserPhone,
  deleteBotUser,
  seedDirector,
};
