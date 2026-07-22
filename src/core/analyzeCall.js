import { withRetry } from './retry.js';
import { findQuote } from './quoteMatch.js';

// Per-call "MAP" step of the evidence-first report pipeline. Runs ONCE per call at ingest (cheap
// model) and the result is cached in calls.behaviors, so per-period reports only aggregate stored
// data (the "REDUCE" in src/bot/analyze.js) instead of re-analysing transcripts every time.
//
// The model tags the MANAGER's behaviours in this one call — strengths and errors — each with a
// VERBATIM quote of a manager line. Then CODE locates every quote in the call's timecoded segments
// (findQuote): a quote that can't be located is dropped (guards against fabrication/paraphrase), and
// a located quote gets its {start,end} so the report can later cut an audio clip around it.

const ANALYSIS_VERSION = 1;
const MAX_ITEMS = 8; // bound noise/cost; the reduce only needs recurring patterns, not everything
const model = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';

const BEHAVIOR_STAGES = [
  'встановлення контакту',
  'виявлення потреби',
  'консультація / презентація',
  'робота із запереченнями',
  'допродаж',
  'закриття (фіксація запису)',
  'інше',
];

const SYSTEM_PROMPT = `Контекст: менеджер автосервісу (СТО) веде телефонну розмову. Успіх = клієнт записаний на сервіс або підтвердив дату приїзду.

Твоє завдання: виділити КОНКРЕТНІ поведінки САМЕ МЕНЕДЖЕРА в цьому одному дзвінку — і сильні, і слабкі — та підкріпити кожну ДОСЛІВНОЮ цитатою рядка менеджера.

Суворі правила:
- Аналізуй лише репліки менеджера (не клієнта).
- Кожна поведінка МУСИТЬ мати "quote" — це рівно один рядок менеджера, СКОПІЙОВАНИЙ ДОСЛІВНО з транскрипту (той самий текст, без переказу, без перекладу, без виправлень). Якщо дослівної цитати немає — не додавай поведінку.
- type: "strength" (сильна) або "error" (слабка/помилка).
- label: коротка назва поведінки (3-6 слів), напр. "Не запропонував конкретну дату" або "Чітко назвав ціну".
- stage: етап розмови зі списку.
- Не вигадуй. Краще менше пунктів, але з реальними цитатами. Для тривіального дзвінка (просте підтвердження) поведінок може бути 0-1.
- Не більше 8 поведінок.`;

const SCHEMA = {
  name: 'call_behaviors',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['strength', 'error'] },
            stage: { type: 'string', enum: BEHAVIOR_STAGES },
            label: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['type', 'stage', 'label', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
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

// Returns the behaviors object to store: { version, items:[{type,stage,label,quote,start,end,segIndex}] }.
// segments (from ElevenLabs) carry timecodes; when null we verify against the transcript instead
// (items kept, but start/end stay null so no audio clip is produced for them).
async function analyzeCallBehaviors(transcript, segments, managerName) {
  const verifySegments = Array.isArray(segments) && segments.length ? segments : pseudoSegments(transcript);
  if (!transcript || !verifySegments.length) return { version: ANALYSIS_VERSION, items: [] };

  const raw = await withRetry(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model(),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `${managerName ? `Менеджер: ${managerName}\n\n` : ''}Транскрипт:\n${transcript}`,
            },
          ],
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI call-behaviors failed: ${res.status} ${await res.text()}`);
      return JSON.parse((await res.json()).choices[0].message.content);
    },
    { attempts: 2, delayMs: 1500, label: 'OpenAI call behaviors' }
  );

  const items = [];
  for (const it of (raw.items || []).slice(0, MAX_ITEMS)) {
    if (!it?.quote) continue;
    // Verify the quote is really in the call; drop it otherwise (anti-fabrication). Located quotes
    // carry their timecode for later audio clipping.
    const hit = findQuote(verifySegments, it.quote, { preferRole: 'manager' });
    if (!hit) continue;
    items.push({
      type: it.type === 'strength' ? 'strength' : 'error',
      stage: it.stage || 'інше',
      label: String(it.label || '').trim(),
      quote: it.quote.trim(),
      start: hit.start,
      end: hit.end,
      segIndex: hit.segIndex,
    });
  }
  return { version: ANALYSIS_VERSION, items };
}

export { analyzeCallBehaviors, ANALYSIS_VERSION, BEHAVIOR_STAGES };
