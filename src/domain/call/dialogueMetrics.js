import { config } from '../../shared/config.js';

const EDGE = '(?:^|[^\\p{L}])';

const CUT_OFF_RE = /[-–—‐‑]{1,3}$/u;
const TRAILED_OFF_RE = /(?:\.{2,3}|…)$/u;

const WARNING_WORDS = [
  'секунд', 'сек', 'хвилинк', 'хвилиночк', 'хвилин', 'минутк', 'минуточк', 'минут', 'момент',
  'зараз', 'щас', 'сейчас', 'подожд', 'почекай', 'зачекай', 'потерп',
  'перевір', 'провер', 'уточн', 'подивл', 'подивіт', 'посмотр', 'глян', 'дізна', 'узна',
  'знайд', 'найд', 'передзвон', 'перезвон', 'не кладіть', 'не кладите', 'на лінії', 'на линии',
];
const WARNING_RE = new RegExp(`${EDGE}(?:${WARNING_WORDS.join('|')})`, 'iu');

const BACKCHANNEL = new Set([
  'ага', 'угу', 'угум', 'мгм', 'м', 'мм', 'ммм', 'мммм', 'да', 'так', 'ок', 'окей', 'ну',
  'е', 'ее', 'еее', 'а', 'аа', 'ааа', 'о', 'оо', 'я', 'все', 'всьо', 'всё', 'от',
  'конечно', 'звичайно', 'понял', 'поняв', 'зрозумів', 'зрозуміло', 'понятно', 'ясно',
  'хорошо', 'добре', 'бачу', 'вижу', 'точно', 'ладно', 'угуму',
]);

const MIN_CLIENT_TURN_CHARS = 15;
const MIN_MANAGER_TURN_CHARS = 10;
const MIN_INTERRUPTED_CHARS = 12;
const FRAGMENT_CHARS = 6;
const FRAGMENTED_SHARE = 0.3;

const INTERRUPT_OVERLAP = 'overlap';
const INTERRUPT_CUT_OFF = 'cut_off';

const PAUSE_HOLD = 'hold';
const PAUSE_WARNED_BEFORE = 'warned_before';
const PAUSE_WARNED_AFTER = 'warned_after';
const PAUSE_CLIENT_SILENT = 'client_asked_nothing';
const PAUSE_MANAGER_SILENT = 'manager_said_nothing';
const PAUSE_SAME_EXCHANGE = 'same_exchange';

const PAUSE_REASON_LABELS = {
  [PAUSE_HOLD]: 'переведення дзвінка',
  [PAUSE_WARNED_BEFORE]: 'менеджер попередив',
  [PAUSE_WARNED_AFTER]: 'менеджер пояснив затримку',
  [PAUSE_CLIENT_SILENT]: 'клієнт нічого не питав',
  [PAUSE_MANAGER_SILENT]: 'відповідь коротша за репліку',
  [PAUSE_SAME_EXCHANGE]: 'той самий обмін репліками',
};

function longPauseSec() {
  return config.call.longPauseSec;
}

function holdSuspectSec() {
  return config.call.holdSuspectSec;
}

function interruptOverlapSec() {
  return config.call.interruptOverlapSec;
}

const isClient = (s) => s?.role === 'client';
const isManager = (s) => s?.role === 'manager';
const clean = (t) => String(t ?? '').trim();

function isBackchannel(text) {
  const words = clean(text).toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => BACKCHANNEL.has(w));
}

function isFragmented(segs) {
  if (!segs.length) return false;
  const fragments = segs.filter((s) => clean(s.text).length < FRAGMENT_CHARS).length;
  return fragments / segs.length > FRAGMENTED_SHARE;
}
const warnsAboutDelay = (text) => WARNING_RE.test(clean(text));

function mmss(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '--:--';
  const total = Math.max(0, Math.round(Number(sec)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const round1 = (n) => Math.round(n * 10) / 10;

function overlapHit(segs, clientIndex, minOverlapSec) {
  const cur = segs[clientIndex];
  if (cur.start == null || cur.end == null) return null;
  for (let j = clientIndex + 1; j < segs.length; j += 1) {
    const next = segs[j];
    if (next.start == null) continue;
    if (Number(next.start) >= Number(cur.end)) return null;
    if (!isManager(next)) continue;
    const managerEnd = next.end == null ? null : Number(next.end);
    if (managerEnd != null && Number(cur.end) > managerEnd) return null;
    const overlap = Math.min(Number(cur.end), managerEnd ?? Number(cur.end)) - Number(next.start);
    if (!(overlap > minOverlapSec)) return null;
    const quote = clean(next.text);
    if (quote.length < MIN_MANAGER_TURN_CHARS || isBackchannel(quote)) return null;
    return { segIndex: j, overlapSec: round1(overlap), kind: INTERRUPT_OVERLAP };
  }
  return null;
}

function cutOffHit(segs, clientIndex) {
  if (!CUT_OFF_RE.test(clean(segs[clientIndex].text))) return null;
  const j = clientIndex + 1;
  const next = segs[j];
  if (!isManager(next)) return null;
  const quote = clean(next.text);
  if (quote.length < MIN_MANAGER_TURN_CHARS || isBackchannel(quote)) return null;
  return { segIndex: j, overlapSec: 0, kind: INTERRUPT_CUT_OFF };
}

function detectInterruptions(segments, minOverlapSec = interruptOverlapSec()) {
  const segs = Array.isArray(segments) ? segments : [];
  const chopped = isFragmented(segs);
  const out = [];
  for (let i = 0; i < segs.length - 1; i += 1) {
    const cur = segs[i];
    if (!isClient(cur)) continue;
    const clientText = clean(cur.text);
    if (clientText.length < MIN_INTERRUPTED_CHARS) continue;
    if (TRAILED_OFF_RE.test(clientText)) continue;

    const hit = (chopped ? null : overlapHit(segs, i, minOverlapSec)) ?? cutOffHit(segs, i);
    if (!hit) continue;
    const next = segs[hit.segIndex];
    out.push({
      clientIndex: i,
      segIndex: hit.segIndex,
      clientText,
      quote: clean(next.text),
      overlapSec: hit.overlapSec,
      kind: hit.kind,
      start: next.start ?? null,
      end: next.end ?? null,
      at: next.start ?? cur.end ?? null,
    });
  }
  return out;
}

const TAIL = 160;
const tail = (t) => (t.length > TAIL ? `…${t.slice(-TAIL)}` : t);

function pauseReason(pause, holdSec) {
  if (pause.pauseSec > holdSec) return PAUSE_HOLD;
  if (warnsAboutDelay(pause.prevManagerText)) return PAUSE_WARNED_BEFORE;
  if (warnsAboutDelay(pause.quote)) return PAUSE_WARNED_AFTER;
  if (isBackchannel(pause.clientText) || pause.clientText.length < MIN_CLIENT_TURN_CHARS) return PAUSE_CLIENT_SILENT;
  if (isBackchannel(pause.quote) || pause.quote.length < MIN_MANAGER_TURN_CHARS) return PAUSE_MANAGER_SILENT;
  return null;
}

function detectLongPauses(segments, thresholdSec = longPauseSec(), holdSec = holdSuspectSec()) {
  const segs = Array.isArray(segments) ? segments : [];
  const out = [];
  let lastCountedSegIndex = null;
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
    const found = {
      clientIndex: i,
      segIndex: i + 1,
      pauseSec: round1(pause),
      clientText: clean(cur.text),
      prevManagerText,
      quote: clean(next.text),
      start: next.start ?? null,
      end: next.end ?? null,
      at: cur.end,
    };
    let reason = pauseReason(found, holdSec);
    if (!reason && lastCountedSegIndex === i - 1) reason = PAUSE_SAME_EXCHANGE;
    if (!reason) lastCountedSegIndex = i + 1;
    out.push({ ...found, justified: reason != null, reason });
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
      `- Менеджер не дав клієнту договорити ${interruptions.length} раз(и):`
    );
    for (const it of interruptions.slice(0, 5)) {
      const how = it.kind === INTERRUPT_OVERLAP ? `почав поверх за ${it.overlapSec}с до кінця` : 'репліку клієнта обірвано';
      lines.push(`  · ${mmss(it.at)} клієнт: «${tail(it.clientText)}» → менеджер (${how}): «${it.quote}»`);
    }
  }
  if (longPauses.length) {
    lines.push(`- Пауз довших за ${thresholdSec}с перед відповіддю менеджера: ${longPauses.length}:`);
    for (const p of longPauses.slice(0, 5)) {
      const before = p.prevManagerText ? ` (перед тим менеджер сказав: «${tail(p.prevManagerText)}»)` : '';
      const verdict = p.justified ? ` [пауза законна: ${PAUSE_REASON_LABELS[p.reason] ?? p.reason}]` : '';
      lines.push(`  · ${mmss(p.at)} пауза ${p.pauseSec}с після «${tail(p.clientText)}»${before} → «${p.quote}»${verdict}`);
    }
  }
  lines.push(
    'Паузи, позначені як законні, у мінус не ставити — їх уже перевірив код.'
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
  dialogueMetrics,
  detectInterruptions,
  detectLongPauses,
  metricsPromptBlock,
  timecodedDialogue,
  longPauseSec,
  INTERRUPT_OVERLAP,
  INTERRUPT_CUT_OFF,
  warnsAboutDelay,
  isBackchannel,
  PAUSE_HOLD,
  PAUSE_WARNED_BEFORE,
  PAUSE_WARNED_AFTER,
  PAUSE_CLIENT_SILENT,
  PAUSE_MANAGER_SILENT,
  PAUSE_SAME_EXCHANGE,
};
