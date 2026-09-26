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
