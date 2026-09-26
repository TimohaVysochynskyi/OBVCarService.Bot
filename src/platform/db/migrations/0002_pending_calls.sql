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
