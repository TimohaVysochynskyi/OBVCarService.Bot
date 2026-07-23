import { displayName } from './operators.js';

// Growth dashboard for a manager — the primary screen of "Статистика менеджера". Renders a numeric
// TRAJECTORY across buckets (Kyiv weeks or months) + how the weakest sales stage evolved + a growth
// verdict (first→last deltas). Pure text builder (no DB/LLM) → easy to unit-test; the caller feeds
// buckets from store.getBucketedTrend (chronological, oldest→newest).

const MONTHS_UK = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];

const pad2 = (n) => String(n).padStart(2, '0');
const partsOf = (ymd) => ymd.split('-').map(Number); // [y, m, d]

// "dd.mm–dd.mm" for a week starting at ymd (Monday), or "лип'26" for a month.
function bucketLabel(ymd, bucket) {
  const [y, m, d] = partsOf(ymd);
  if (bucket === 'month') return `${MONTHS_UK[m - 1]}'${String(y).slice(-2)}`;
  const endMs = Date.UTC(y, m - 1, d + 6);
  const e = new Date(endMs);
  return `${pad2(d)}.${pad2(m)}–${pad2(e.getUTCDate())}.${pad2(e.getUTCMonth() + 1)}`;
}

const convOf = (b) => (b.salesCount ? Math.round((b.successCount / b.salesCount) * 100) : 0);

// arrow vs previous value; null-safe (no arrow when either side is missing)
function arrow(cur, prev) {
  if (cur == null || prev == null) return ' ';
  if (cur > prev) return '↑';
  if (cur < prev) return '↓';
  return '·';
}

const shortStage = (s) => {
  if (!s) return '—';
  return s
    .replace('виявлення потреби', 'виявл. потреби')
    .replace('робота із запереченнями', 'заперечення')
    .replace('закриття угоди', 'закриття');
};

// Returns the message text (Markdown; the trajectory table is in a ``` block so columns align).
function buildDynamicsText(name, bucket, buckets) {
  const title = `📈 *Динаміка — ${displayName(name)}*  ·  ${bucket === 'month' ? 'місяці' : 'тижні'}`;
  if (!buckets.length) {
    return `${title}\n\nЩе немає даних для цього менеджера.`;
  }

  // Trajectory table (monospace).
  const head = `${'Період'.padEnd(13)}${'Дзв'.padStart(4)} ${'Конв'.padStart(5)} ${'Бал'.padStart(5)}`;
  const rows = [head];
  buckets.forEach((b, i) => {
    const prev = i > 0 ? buckets[i - 1] : null;
    const conv = convOf(b);
    const convArr = prev ? arrow(conv, convOf(prev)) : ' ';
    const scoreNum = b.avgScore == null ? null : Number(b.avgScore);
    const scoreArr = prev ? arrow(scoreNum, prev.avgScore == null ? null : Number(prev.avgScore)) : ' ';
    const label = bucketLabel(b.bucketStart, bucket).padEnd(13);
    const calls = String(b.callCount).padStart(4);
    const convCell = `${conv}%${convArr}`.padStart(5);
    const scoreCell = `${b.avgScore ?? '—'}${scoreArr}`.padStart(5);
    rows.push(`${label}${calls} ${convCell} ${scoreCell}`);
  });
  const table = '```\n' + rows.join('\n') + '\n```';

  // Weakest-stage evolution (one line per bucket).
  const stageLines = buckets
    .map((b) => `• ${bucketLabel(b.bucketStart, bucket)}: ${shortStage(b.topWeakStage)}`)
    .join('\n');

  // Growth verdict: first vs last bucket.
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const dConv = convOf(last) - convOf(first);
  const fScore = first.avgScore == null ? null : Number(first.avgScore);
  const lScore = last.avgScore == null ? null : Number(last.avgScore);
  const dScore = fScore != null && lScore != null ? Math.round((lScore - fScore) * 10) / 10 : null;

  let verdict = 'недостатньо даних для тренду';
  if (buckets.length >= 2) {
    const ups = (dConv > 0 ? 1 : 0) + (dScore != null && dScore > 0 ? 1 : 0);
    const downs = (dConv < 0 ? 1 : 0) + (dScore != null && dScore < 0 ? 1 : 0);
    if (ups && !downs) verdict = 'РІСТ ✅';
    else if (downs && !ups) verdict = 'СПАД ⚠️';
    else if (ups && downs) verdict = 'змішана 🔄';
    else verdict = 'без змін ➖';
  }

  // Recurring weakness = most frequent per-bucket weakest stage.
  const freq = {};
  buckets.forEach((b) => {
    if (b.topWeakStage) freq[b.topWeakStage] = (freq[b.topWeakStage] || 0) + 1;
  });
  const recurring = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];

  const convWord = dConv === 0 ? '±0' : `${dConv > 0 ? '+' : ''}${dConv} п.п.`;
  const scoreWord = dScore == null ? '—' : dScore === 0 ? '±0' : `${dScore > 0 ? '+' : ''}${dScore}`;
  const summary =
    `📊 *Підсумок за ${buckets.length} ${bucket === 'month' ? 'міс.' : 'тижн.'}:*\n` +
    `Конверсія ${convOf(first)}%→${convOf(last)}% (${convWord}), бал ${first.avgScore ?? '—'}→${last.avgScore ?? '—'} (${scoreWord}).\n` +
    (recurring ? `Найчастіша слабина: ${shortStage(recurring[0])} (${recurring[1]}/${buckets.length}).\n` : '') +
    `Динаміка: *${verdict}*`;

  return `${title}\n\n${table}\n🎯 *Слабкий етап по бакетах:*\n${stageLines}\n\n${summary}`;
}

export { buildDynamicsText };
