-- Engine-repair requests, captured per call so the owner can see whether advertising that service
-- actually moves the numbers: "how many called about it, which engines, which service".
--   engine_request — TRUE/FALSE after the detector ran, NULL = not checked yet (what the backfill
--                    picks up). FALSE is stored explicitly, so a call is never re-analysed twice.
--   engine_service — one fixed bucket from domain/call/engine.js (overhaul / head / diagnostics /
--                    replacement / turbo / fuel / timing / maintenance / other).
--   engine_car     — make and model as the client said it ("Passat 1.9 TDI"), for the "which
--                    engines" cut. NULL when the car was never named - never guessed.
--   engine_quote   — the verbatim line the verdict rests on; the code re-checks it against the
--                    transcript, so a request cannot be invented.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS engine_request BOOLEAN;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS engine_service TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS engine_car TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS engine_quote TEXT;
CREATE INDEX IF NOT EXISTS calls_engine_request ON calls (start_time) WHERE engine_request;
