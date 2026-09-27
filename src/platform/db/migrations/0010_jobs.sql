-- Long reprocess runs (/prompt → "Перезаписати всі"/"Застосувати вибірково"). The progress used to
-- live in the bot process's memory, so `pm2 reload` in the middle threw away work the owner had
-- already paid for: the loop died, the Telegram message froze, and a re-run started the block from
-- the beginning, asking the model again about calls it had just finished.
--   cursor     — how many calls of the window were already looked at. The worker resumes from here,
--                so a restart costs at most the one call that was in flight.
--   chat_id /
--   message_id — where the progress message lives, so a run resumed by ANOTHER process keeps
--                editing the same message instead of leaving a dead one.
--   status     — 'running' | 'done' | 'cancelled' | 'failed'. "⛔️ Зупинити" writes 'cancelled',
--                which is why a stop survives a restart too.
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  params JSONB,
  cursor INTEGER NOT NULL DEFAULT 0,
  total INTEGER,
  done INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  chat_id BIGINT,
  message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Один перерахунок водночас" is enforced by the DATABASE, not by a flag in memory: a flag does not
-- survive a restart and knows nothing about the other process. Two concurrent runs would share one
-- 30k tokens/min budget and one wallet.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_single_running ON jobs (status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_recent ON jobs (created_at DESC);
