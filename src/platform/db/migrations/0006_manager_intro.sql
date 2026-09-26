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
