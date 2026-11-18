-- Signals that the CLIENT was unhappy with us: "you were supposed to call me back", "I'm calling
-- for the third time", "that's dearer than we agreed". Measured case that forced this: over five
-- calls the system found three strengths and zero faults for a manager who never called the client
-- back, because every piece of evidence in the report must be a MANAGER's line, and the strongest
-- signal here is always the CLIENT's.
--   has_complaint   — TRUE/FALSE after the detector ran, NULL = not checked yet.
--   complaint_type  — one fixed bucket from domain/call/complaint.js.
--   complaint_quote — the client's verbatim line; the code re-finds it among the CLIENT's segments,
--                     so a manager's line can never be passed off as a complaint.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS has_complaint BOOLEAN;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS complaint_type TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS complaint_quote TEXT;
CREATE INDEX IF NOT EXISTS calls_complaint ON calls (start_time) WHERE has_complaint;
