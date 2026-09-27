
const COVERAGE_THRESHOLD = 0.7;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function stripRoleLabel(s) {
  return String(s || '').replace(/^\s*(менеджер|клієнт|клиент|оператор|manager|client)\s*[:\-–—]\s*/i, '');
}

function tokens(norm) {
  return norm ? norm.split(' ').filter(Boolean) : [];
}

function coverage(quoteTokens, segTokenSet) {
  if (quoteTokens.length === 0) return 0;
  let hit = 0;
  for (const t of new Set(quoteTokens)) if (segTokenSet.has(t)) hit += 1;
  return hit / new Set(quoteTokens).size;
}

function findQuote(segments, quote, { preferRole = 'manager', requireRole = null } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const q = normalize(stripRoleLabel(quote));
  if (q.length < 3) return null;
  const qTokens = tokens(q);

  const order = [];
  if (requireRole) {
    segments.forEach((s, i) => s.role === requireRole && order.push(i));
    if (order.length === 0) return null;
  } else if (preferRole) {
    segments.forEach((s, i) => s.role === preferRole && order.push(i));
    segments.forEach((s, i) => s.role !== preferRole && order.push(i));
  } else {
    segments.forEach((_, i) => order.push(i));
  }

  for (const i of order) {
    const s = normalize(segments[i].text);
    if (s && s.includes(q)) {
      return { segIndex: i, start: segments[i].start ?? null, end: segments[i].end ?? null, score: 1 };
    }
  }

  let best = null;
  for (const i of order) {
    const segTokenSet = new Set(tokens(normalize(segments[i].text)));
    const score = coverage(qTokens, segTokenSet);
    if (!best || score > best.score) best = { segIndex: i, score };
  }
  if (best && best.score >= COVERAGE_THRESHOLD) {
    const seg = segments[best.segIndex];
    return { segIndex: best.segIndex, start: seg.start ?? null, end: seg.end ?? null, score: best.score };
  }
  return null;
}

export { findQuote, normalize };
