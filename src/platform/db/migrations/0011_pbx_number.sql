-- pbxNumberData.number - the line the call actually went THROUGH, captured per call.
-- It is the ONLY way to answer "which of the advertised numbers did the client dial": the Binotel
-- REST API has no method that lists our numbers (seven candidates checked, all "102 No such
-- method"), and the extension-to-number mapping in LINE_NUMBERS is configuration, not data.
-- The field arrives with every call and was simply thrown away until 18.11.2026.
--   ⚠️ This is NOT our extension's own number: measured, 901 never once saw its own number, and on
--   an incoming call the field shows the number the CLIENT dialled. That is exactly why it is
--   valuable for measuring advertising, and exactly why it must never be used to infer who answered.
--   ⚠️ pending_calls carries it too: without that, a call that came back through the retry queue
--   would land in calls without the number - the same trap that was already hit with `direction`.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS pbx_number TEXT;
ALTER TABLE pending_calls ADD COLUMN IF NOT EXISTS pbx_number TEXT;
CREATE INDEX IF NOT EXISTS calls_pbx_number ON calls (pbx_number) WHERE pbx_number IS NOT NULL;
