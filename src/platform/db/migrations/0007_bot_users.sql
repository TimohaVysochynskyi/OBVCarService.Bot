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
