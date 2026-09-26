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
