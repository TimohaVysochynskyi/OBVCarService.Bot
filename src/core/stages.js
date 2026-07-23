// Canonical sales-funnel stages — the SINGLE source of truth for the stage taxonomy, used
// EVERYWHERE effectiveness is evaluated:
//   • classifyCall  — the call's weakest stage (calls.weakest_stage, shown in the report header);
//   • analyzeCall   — the stage of each tagged manager behaviour (internal metadata for the reduce).
//
// NOT bot-editable by design: this is a fixed taxonomy, not tunable guidance. Keep it in exactly one
// place so the classifier enum and the behaviour-tagging enum can never drift apart again. Changing
// this list is a taxonomy change — per the CLAUDE.md invariant it would warrant bumping analyzeCall's
// ANALYSIS_VERSION + re-mapping (only relevant if you rely on the internal item.stage of old rows).
export const SALES_STAGES = [
  'виявлення потреби',
  'робота із запереченнями',
  'допродаж',
  'закриття угоди',
];
