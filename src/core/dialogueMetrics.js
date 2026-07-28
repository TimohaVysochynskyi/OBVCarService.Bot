// Dialogue MECHANICS measured from the timecoded segments (calls.segments) — how the manager
// HANDLES the conversation, as opposed to what they say. Two signals the owner asked for:
//
//   • INTERRUPTIONS — the manager talks over the client. ElevenLabs ends a cut-off utterance with a
//     dash or an ellipsis ("Але дивіться-", "Ну-", "але-"), so a client turn ending that way with a
//     MANAGER turn right after it is an interruption. Measured against the live DB (2026-07-27):
//     44 cut-off client turns in sales calls, 42 of them (95%) continued by the manager, present in
//     31% of sales calls — a sparse but very precise signal.
//     ⚠️ We do NOT create those dashes: they come from ElevenLabs' own punctuation (core/elevenlabs.js
//     only joins turn text). So this reads a signal we cannot guarantee — absence of a dash is not
//     proof that nobody was interrupted.
//     ⚠️ Timecode OVERLAP (manager starting before the client's turn ends) was measured too and
//     deliberately NOT used: 6% of client→manager pairs overlap slightly, but inspection showed
//     those are mostly diarization artefacts, which would put false accusations into reports.
//
//   • LONG PAUSES — how long the client waited for an answer. Real distribution on sales calls:
//     median 0.7s, p90 1.7s, >2s in 7.5% of turns, >4s in 1.9%. Threshold: LONG_PAUSE_SEC (4s).
//
// Both are computed in CODE and are therefore verifiable, free, and retroactive: segments are
// already stored, so historical calls get these metrics with no re-ingest. Whether a long pause is
// actually a MISTAKE is left to the LLM (a pause after "секунду, зараз перевірю" is legitimate) —
// code measures, the model judges.

// A cut-off ending: one to three dashes, or an ellipsis. A single period is a normal sentence end
// and must never count (it terminates 3499 of 5719 client turns in the live data).
const CUT_OFF_RE = /(?:[-–—‐‑]{1,3}|\.{2,3}|…)$/u;

const DEFAULT_LONG_PAUSE_SEC = 4;

function longPauseSec() {
  const n = Number(process.env.LONG_PAUSE_SEC);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LONG_PAUSE_SEC;
}

const isClient = (s) => s?.role === 'client';
const isManager = (s) => s?.role === 'manager';
const clean = (t) => String(t ?? '').trim();

// mm:ss (or h:mm:ss past an hour) for display and for prompts.
function mmss(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '--:--';
  const total = Math.max(0, Math.round(Number(sec)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Client turn cut off mid-word with the manager speaking next. The evidence QUOTE is the manager's
// interrupting line (report evidence must be a manager line — see analyze.js: verifyCandidate).
function detectInterruptions(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  const out = [];
  for (let i = 0; i < segs.length - 1; i += 1) {
    const cur = segs[i];
    const next = segs[i + 1];
    if (!isClient(cur) || !isManager(next)) continue;
    if (!CUT_OFF_RE.test(clean(cur.text))) continue;
    out.push({
      clientIndex: i,
      segIndex: i + 1,
      clientText: clean(cur.text),
      quote: clean(next.text),
      start: next.start ?? null,
      end: next.end ?? null,
      at: cur.end ?? next.start ?? null,
    });
  }
  return out;
}

const TAIL = 160;
const tail = (t) => (t.length > TAIL ? `…${t.slice(-TAIL)}` : t);

// Client finished speaking, the manager answered only after >= threshold seconds. The quote is the
// manager's late answer, so the report can cut audio around it.
//
// prevManagerText carries the manager's PREVIOUS line, because that is where the justification lives
// ("секунду, зараз перевірю", "побудь на линії" before a transfer). Verified on live data: the very
// first long pause found was 17.1s that followed the manager saying "буквально дві хвилинки, побудь
// на линии" — a legitimate hold, not a mistake. Without this field the judging model sees only the
// late answer and cannot tell the difference, so it must be part of the candidate context.
function detectLongPauses(segments, thresholdSec = longPauseSec()) {
  const segs = Array.isArray(segments) ? segments : [];
  const out = [];
  for (let i = 0; i < segs.length - 1; i += 1) {
    const cur = segs[i];
    const next = segs[i + 1];
    if (!isClient(cur) || !isManager(next)) continue;
    if (cur.end == null || next.start == null) continue;
    const pause = Number(next.start) - Number(cur.end);
    if (!Number.isFinite(pause) || pause < thresholdSec) continue;
    let prevManagerText = '';
    for (let j = i - 1; j >= 0; j -= 1) {
      if (isManager(segs[j])) {
        prevManagerText = clean(segs[j].text);
        break;
      }
    }
    out.push({
      clientIndex: i,
      segIndex: i + 1,
      pauseSec: Math.round(pause * 10) / 10,
      clientText: clean(cur.text),
      prevManagerText,
      quote: clean(next.text),
      start: next.start ?? null,
      end: next.end ?? null,
      at: cur.end,
    });
  }
  return out;
}

function dialogueMetrics(segments, { thresholdSec = longPauseSec() } = {}) {
  return {
    thresholdSec,
    interruptions: detectInterruptions(segments),
    longPauses: detectLongPauses(segments, thresholdSec),
  };
}

// A short factual block for the scoring prompt. Deliberately FACTS ONLY, no verdict: the rubric
// (owner-editable) decides how much they cost, the model decides whether each one was justified.
function metricsPromptBlock(metrics) {
  if (!metrics) return '';
  const { interruptions, longPauses, thresholdSec } = metrics;
  if (!interruptions.length && !longPauses.length) return '';
  const lines = ['ЗАМІРИ З АУДІО (порахував код, це факти, не оцінки):'];
  if (interruptions.length) {
    lines.push(
      `- Менеджер перебив клієнта ${interruptions.length} раз(и) — клієнт не договорив, менеджер почав говорити:`
    );
    for (const it of interruptions.slice(0, 5)) {
      lines.push(`  · ${mmss(it.at)} клієнт: «${it.clientText}» → менеджер: «${it.quote}»`);
    }
  }
  if (longPauses.length) {
    lines.push(`- Пауз довших за ${thresholdSec}с перед відповіддю менеджера: ${longPauses.length}:`);
    for (const p of longPauses.slice(0, 5)) {
      const before = p.prevManagerText ? ` (перед тим менеджер сказав: «${tail(p.prevManagerText)}»)` : '';
      lines.push(`  · ${mmss(p.at)} пауза ${p.pauseSec}с після «${tail(p.clientText)}»${before} → «${p.quote}»`);
    }
  }
  lines.push(
    'Пауза НЕ є помилкою, якщо менеджер попередив, що щось перевіряє/уточнює, або клієнт сам замовк.'
  );
  return lines.join('\n');
}

// The dialogue with a timecode in front of every turn ("00:12 Менеджер: …"). Used both for the
// archive view (the director can see how fast a manager reacts) and as the model's input for
// scoring, so response latency is visible to it at all.
function timecodedDialogue(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  if (!segs.length) return '';
  return segs
    .map((s) => `${mmss(s.start)} ${s.role === 'manager' ? 'Менеджер' : 'Клієнт'}: ${clean(s.text)}`)
    .join('\n\n');
}

export {
  detectInterruptions,
  detectLongPauses,
  dialogueMetrics,
  metricsPromptBlock,
  timecodedDialogue,
  mmss,
  longPauseSec,
  CUT_OFF_RE,
  DEFAULT_LONG_PAUSE_SEC,
};
