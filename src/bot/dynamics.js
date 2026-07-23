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

  // Growth verdict: compare the first vs last MEANINGFUL bucket, ignoring near-empty ones (a bucket
  // with 0 sales / no score would otherwise distort the trend — e.g. a 2-call week reading as 0%).
  const salesB = buckets.filter((b) => b.salesCount > 0);
  const scoreB = buckets.filter((b) => b.avgScore != null);
  const convFirst = salesB.length ? convOf(salesB[0]) : null;
  const convLast = salesB.length ? convOf(salesB[salesB.length - 1]) : null;
  const dConv = salesB.length >= 2 ? convLast - convFirst : null;
  const sFirst = scoreB.length ? Number(scoreB[0].avgScore) : null;
  const sLast = scoreB.length ? Number(scoreB[scoreB.length - 1].avgScore) : null;
  const dScore = scoreB.length >= 2 ? Math.round((sLast - sFirst) * 10) / 10 : null;

  // Dead-zones so small fluctuations (noise) don't read as a real trend.
  const CONV_EPS = 3; // percentage points
  const SCORE_EPS = 0.3;
  let verdict = 'недостатньо даних для тренду';
  if (dConv != null || dScore != null) {
    const ups = (dConv != null && dConv >= CONV_EPS ? 1 : 0) + (dScore != null && dScore >= SCORE_EPS ? 1 : 0);
    const downs = (dConv != null && dConv <= -CONV_EPS ? 1 : 0) + (dScore != null && dScore <= -SCORE_EPS ? 1 : 0);
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

  const convWord = dConv == null ? '—' : dConv === 0 ? '±0' : `${dConv > 0 ? '+' : ''}${dConv} п.п.`;
  const scoreWord = dScore == null ? '—' : dScore === 0 ? '±0' : `${dScore > 0 ? '+' : ''}${dScore}`;
  const convLine = `Конверсія ${convFirst ?? '—'}%→${convLast ?? '—'}% (${convWord})`;
  const scoreLine = `бал ${sFirst ?? '—'}→${sLast ?? '—'} (${scoreWord})`;
  const summary =
    `📊 *Підсумок за ${buckets.length} ${bucket === 'month' ? 'міс.' : 'тижн.'}:*\n` +
    `${convLine}, ${scoreLine}.\n` +
    (recurring ? `Найчастіша слабина: ${shortStage(recurring[0])} (${recurring[1]}/${buckets.length}).\n` : '') +
    `Динаміка: *${verdict}*`;

  return `${title}\n\n${table}\n🎯 *Слабкий етап по бакетах:*\n${stageLines}\n\n${summary}`;
}

export { buildDynamicsText };
