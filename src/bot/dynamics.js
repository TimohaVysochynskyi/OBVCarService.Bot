import { displayName } from "./operators.js";


const MAX_BUCKETS = 12;

const MONTHS_UK = [
  "січ",
  "лют",
  "бер",
  "кві",
  "тра",
  "чер",
  "лип",
  "сер",
  "вер",
  "жов",
  "лис",
  "гру",
];

const pad2 = (n) => String(n).padStart(2, "0");
const partsOf = (ymd) => ymd.split("-").map(Number);

function pluralize(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
const bucketWord = (n, bucket) =>
  bucket === "month"
    ? pluralize(n, "місяць", "місяці", "місяців")
    : pluralize(n, "тиждень", "тижні", "тижнів");

function bucketLabel(ymd, bucket) {
  const [y, m, d] = partsOf(ymd);
  if (bucket === "month") return `${MONTHS_UK[m - 1]}'${String(y).slice(-2)}`;
  const endMs = Date.UTC(y, m - 1, d + 6);
  const e = new Date(endMs);
  return `${pad2(d)}.${pad2(m)}–${pad2(e.getUTCDate())}`;
}

const reachableOf = (b) => (b.reachableCount == null ? b.salesCount : b.reachableCount);
const convOf = (b) => {
  const base = reachableOf(b);
  return base ? Math.round((b.successCount / base) * 100) : 0;
};

function arrow(cur, prev) {
  if (cur == null || prev == null) return " ";
  if (cur > prev) return "↑";
  if (cur < prev) return "↓";
  return "·";
}

function buildDynamicsText(name, bucket, buckets) {
  if (!buckets.length) {
    return `📈 *Менеджер: ${displayName(name)}*\n\nЩе немає даних для цього менеджера.`;
  }
  const title = `📈 *Менеджер: ${displayName(name)}* · останні ${buckets.length} ${bucketWord(buckets.length, bucket)}`;

  const BAL_DATA_WIDTH = 5;
  const head = `${"Період".padEnd(10)}${"Дзв".padStart(4)} ${"Кон".padStart(5)} ${"Бал".padStart(4)}  ${"Черга".padStart(5)} ${"Профіль".padStart(7)}`;
  const rows = [head];
  buckets.forEach((b, i) => {
    const prev = i > 0 ? buckets[i - 1] : null;
    const conv = convOf(b);
    const convArr = prev ? arrow(conv, convOf(prev)) : " ";
    const scoreNum = b.avgScore == null ? null : Number(b.avgScore);
    const scoreArr = prev
      ? arrow(scoreNum, prev.avgScore == null ? null : Number(prev.avgScore))
      : " ";
    const label = bucketLabel(b.bucketStart, bucket).padEnd(10);
    const calls = String(b.callCount).padStart(4);
    const convCell = `${conv}%${convArr}`.padStart(5);
    const scoreCell = `${b.avgScore ?? "—"}${scoreArr}`.padStart(BAL_DATA_WIDTH);
    const queueCell = String(b.blockedNoSlot ?? "—").padStart(5);
    const notTaken =
      b.blockedOutOfScope == null && b.blockedNoParts == null
        ? null
        : (b.blockedOutOfScope || 0) + (b.blockedNoParts || 0);
    const scopeCell = String(notTaken ?? "—").padStart(7);
    rows.push(`${label}${calls} ${convCell} ${scoreCell} ${queueCell} ${scopeCell}`);
  });
  const table = "```\n" + rows.join("\n") + "\n```";

  const stageLines = buckets
    .map(
      (b) =>
        `• ${bucketLabel(b.bucketStart, bucket)}: ${b.topWeakStage || "—"}`,
    )
    .join("\n");

  const salesB = buckets.filter((b) => b.salesCount > 0);
  const scoreB = buckets.filter((b) => b.avgScore != null);
  const convFirst = salesB.length ? convOf(salesB[0]) : null;
  const convLast = salesB.length ? convOf(salesB[salesB.length - 1]) : null;
  const dConv = salesB.length >= 2 ? convLast - convFirst : null;
  const sFirst = scoreB.length ? Number(scoreB[0].avgScore) : null;
  const sLast = scoreB.length
    ? Number(scoreB[scoreB.length - 1].avgScore)
    : null;
  const dScore =
    scoreB.length >= 2 ? Math.round((sLast - sFirst) * 10) / 10 : null;

  const CONV_EPS = 3;
  const SCORE_EPS = 0.3;
  let verdict = "недостатньо даних для тренду";
  if (dConv != null || dScore != null) {
    const ups =
      (dConv != null && dConv >= CONV_EPS ? 1 : 0) +
      (dScore != null && dScore >= SCORE_EPS ? 1 : 0);
    const downs =
      (dConv != null && dConv <= -CONV_EPS ? 1 : 0) +
      (dScore != null && dScore <= -SCORE_EPS ? 1 : 0);
    if (ups && !downs) verdict = "РІСТ ✅";
    else if (downs && !ups) verdict = "СПАД ⚠️";
    else if (ups && downs) verdict = "нестабільна 🔄";
    else verdict = "без змін ➖";
  }

  const totalReachable = buckets.reduce((s, b) => s + (reachableOf(b) || 0), 0);
  const totalSuccess = buckets.reduce((s, b) => s + (b.successCount || 0), 0);
  const avgConv = totalReachable
    ? Math.round((totalSuccess / totalReachable) * 100)
    : null;
  const totalBlocked = buckets.reduce(
    (s, b) => s + (b.blockedNoSlot || 0) + (b.blockedNoParts || 0) + (b.blockedOutOfScope || 0),
    0,
  );
  const scoredBuckets = buckets.filter((b) => b.avgScore != null);
  const avgScoreOverall = scoredBuckets.length
    ? Math.round(
        (scoredBuckets.reduce((s, b) => s + Number(b.avgScore), 0) /
          scoredBuckets.length) *
          10,
      ) / 10
    : null;

  const blockedLine = totalBlocked
    ? `Незакриті не з вини менеджера: ${totalBlocked}\n`
    : "";

  const summary =
    `📊 *Підсумок за ${buckets.length} ${bucketWord(buckets.length, bucket)}:*\n` +
    `Середня конверсія ${avgConv ?? "—"}%\n` +
    `Середній бал ${avgScoreOverall ?? "—"}\n` +
    blockedLine +
    `Динаміка: *${verdict}*`;

  return `${title}\n\n${table}\n👎 *Проблемні сегменти воронки:*\n${stageLines}\n\n${summary}`;
}

export { buildDynamicsText, MAX_BUCKETS };
