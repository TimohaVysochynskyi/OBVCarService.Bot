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
