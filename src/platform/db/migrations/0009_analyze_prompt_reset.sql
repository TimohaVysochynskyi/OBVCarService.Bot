-- One-time reset of the legacy PROSE analysis prompt. The report was rewritten to an
-- evidence-first pipeline (analyze.js), so an old stored prose prompt would be stale guidance.
-- Guarded by a marker key => runs at most once; the owner can re-customize via /prompt after.
DELETE FROM app_state WHERE key = 'analyze_prompt'
  AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = 'analyze_prompt_v2');
INSERT INTO app_state (key, value) VALUES ('analyze_prompt_v2', '1')
  ON CONFLICT (key) DO NOTHING;
