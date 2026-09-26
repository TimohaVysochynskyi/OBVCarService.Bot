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
