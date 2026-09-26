
const CUT_OFF_RE = /(?:[-–—‐‑]{1,3}|\.{2,3}|…)$/u;

const DEFAULT_LONG_PAUSE_SEC = 4;

function longPauseSec() {
  const n = Number(process.env.LONG_PAUSE_SEC);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LONG_PAUSE_SEC;
}

const isClient = (s) => s?.role === 'client';
const isManager = (s) => s?.role === 'manager';
const clean = (t) => String(t ?? '').trim();

function mmss(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '--:--';
  const total = Math.max(0, Math.round(Number(sec)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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
