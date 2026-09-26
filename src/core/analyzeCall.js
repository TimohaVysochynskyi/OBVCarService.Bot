import { withRetry } from './retry.js';
import { parseModelJson } from './errors.js';
import { fetchOk } from './http.js';
import { findQuote } from './quoteMatch.js';
import { SALES_STAGES } from './stages.js';

// Per-call "MAP" step of the evidence-first report pipeline. Runs ONCE per call at ingest (cheap
// model) and the result is cached in calls.behaviors, so per-period reports only aggregate stored
// data (the "REDUCE" in src/bot/analyze.js) instead of re-analysing transcripts every time.
//
// The model tags the MANAGER's behaviours in this one call — strengths and errors — each with a
// VERBATIM quote of a manager line. Then CODE locates every quote in the call's timecoded segments
// (findQuote): a quote that can't be located is dropped (guards against fabrication/paraphrase), and
// a located quote gets its {start,end} so the report can later cut an audio clip around it.

const ANALYSIS_VERSION = 2;
const MAX_ITEMS = 8; // bound noise/cost; the reduce only needs recurring patterns, not everything
const model = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';
const NO_INTRO = { name: false, company: false };

// Stage taxonomy is shared with classifyCall (core/stages.js) — one vocabulary everywhere. item.stage
// is INTERNAL metadata (a hint for the report reduce's clustering); it is NOT shown in the delivered
// finding, so constraining it to the 4 sales stages costs nothing user-visible.

// Purpose of the call, decided first. Only 'sales' calls feed the sales-effectiveness report;
// 'info'/'other' calls contribute NO behaviours (so a routine status update never becomes a
// "sales mistake"). The purpose is also stored per call (calls.call_purpose) for the report's
// sales-vs-info numeric breakdown.
import { CALL_PURPOSES, purposeRules } from './callPurpose.js';
import { definePrompt } from './prompts.js';
// Did he give his name and the service's name? Asked HERE because this request already runs on
// every call, so the two booleans cost nothing extra. Rules live in one module with the offline
// rule-based detector that back-fills history, so the two paths can't drift apart.
import { introRules, verifyIntro } from './managerIntro.js';

// Split into three editable parts rather than one blob: the owner usually wants to tune ONE of
// them (what counts as a deal, what counts as an introduction, what counts as a behaviour), and a
// single giant text would mean re-reading everything to change one line.
const behaviourRules = definePrompt({
  key: 'behaviour',
  group: 'call',
  job: 'map',
  button: '🔍 Сильні й слабкі сторони в розмові',
  title: '🔍 *Сильні й слабкі сторони в розмові*',
  about:
    'Що саме AI виписує з кожного дзвінка-угоди як сильну чи слабку поведінку менеджера. ' +
    'Саме з цих поведінок потім збираються висновки у звіті. ' +
    '⚠️ Правило «цитата має бути справжньою реплікою менеджера» тримає код і не редагується.',
});

// Assembled per call so an edit takes effect without a restart.
async function systemPrompt() {
  return `Контекст: менеджер автосервісу (СТО) веде телефонну розмову.

КРОК 0 — чи ПРЕДСТАВИВСЯ менеджер (intro). Заповнюй ЗАВЖДИ, на дзвінку будь-якого типу:
${await introRules()}

КРОК 1 — визнач ТИП дзвінка (callPurpose):
${await purposeRules()}

КРОК 2 — поведінки менеджера (items):
${await behaviourRules()}`;
}

const SCHEMA = {
  name: 'call_behaviors',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      callPurpose: { type: 'string', enum: CALL_PURPOSES },
      intro: {
        type: 'object',
        properties: {
          name: { type: 'boolean' },
          nameQuote: { type: 'string' },
          company: { type: 'boolean' },
          companyQuote: { type: 'string' },
        },
        required: ['name', 'nameQuote', 'company', 'companyQuote'],
        additionalProperties: false,
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['strength', 'error'] },
            stage: { type: 'string', enum: SALES_STAGES },
            label: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['type', 'stage', 'label', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['callPurpose', 'intro', 'items'],
    additionalProperties: false,
  },
};

// When a call has no diarized segments (OpenAI fallback path), build verification-only pseudo
// segments from the plain transcript so quotes can still be validated (no timecodes → no audio).
function pseudoSegments(transcript) {
  const text = String(transcript || '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) {
    const m = /^(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*(.*)$/i.exec(l);
    if (m) out.push({ role: /менеджер|оператор/i.test(m[1]) ? 'manager' : 'client', text: m[2], start: null, end: null });
    else out.push({ role: 'manager', text: l, start: null, end: null });
  }
  if (out.length === 0 && text.trim()) out.push({ role: 'manager', text: text.trim(), start: null, end: null });
  return out;
}

// Returns { version, callPurpose, items:[{type,stage,label,quote,start,end,segIndex}] }.
// callPurpose gates everything: only 'sales' calls get behaviours (info/other → items:[]). segments
// (from ElevenLabs) carry timecodes; when null we verify against the transcript instead (items kept,
// but start/end stay null so no audio clip is produced). A quote is accepted ONLY if it's found in a
// MANAGER segment (requireRole) — a client line can't be mislabelled as a manager behaviour.
async function analyzeCallBehaviors(transcript, segments, managerName) {
  const verifySegments = Array.isArray(segments) && segments.length ? segments : pseudoSegments(transcript);
  if (!transcript || !verifySegments.length) return { version: ANALYSIS_VERSION, callPurpose: 'other', intro: NO_INTRO, items: [] };

  const system = await systemPrompt();
  const raw = await withRetry(
    async () => {
      const res = await fetchOk('openai', 'аналіз поведінки в дзвінку', 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model(),
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: `${managerName ? `Менеджер: ${managerName}\n\n` : ''}Транскрипт:\n${transcript}`,
            },
          ],
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      return parseModelJson(await res.json(), 'openai', 'аналіз поведінки в дзвінку');
    },
    { attempts: 2, delayMs: 1500, label: 'OpenAI call behaviors' }
  );

  const callPurpose = CALL_PURPOSES.includes(raw.callPurpose) ? raw.callPurpose : 'other';
  // Kept for EVERY purpose: an introduction is expected on an info call as much as on a deal.
  // The model's answer is not taken at face value — verifyIntro re-finds the quoted line in this
  // call's own manager segments. Measured on live calls: without that check the model said "yes" on
  // every single one, reading the "Менеджер: <імʼя>" metadata line as the name having been spoken.
  const intro = verifyIntro(raw.intro, verifySegments, managerName);
  // Non-sales calls contribute no behaviours to the sales-effectiveness report.
  if (callPurpose !== 'sales') return { version: ANALYSIS_VERSION, callPurpose, intro, items: [] };

  const items = [];
  for (const it of (raw.items || []).slice(0, MAX_ITEMS)) {
    if (!it?.quote) continue;
    // Accept only if the quote is a real MANAGER line (anti-fabrication + anti-misattribution).
    // A located quote carries its timecode for later audio clipping.
    const hit = findQuote(verifySegments, it.quote, { requireRole: 'manager' });
    if (!hit) continue;
    items.push({
      type: it.type === 'strength' ? 'strength' : 'error',
      stage: SALES_STAGES.includes(it.stage) ? it.stage : SALES_STAGES[0],
      label: String(it.label || '').trim(),
      quote: it.quote.trim(),
      start: hit.start,
      end: hit.end,
      segIndex: hit.segIndex,
    });
  }
  return { version: ANALYSIS_VERSION, callPurpose, intro, items };
}

export { analyzeCallBehaviors, ANALYSIS_VERSION, CALL_PURPOSES, pseudoSegments };
