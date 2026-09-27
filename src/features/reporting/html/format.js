const MONTH_NAMES = [
  'січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
  'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень',
];

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const pad2 = (n) => String(n).padStart(2, '0');

function formatDate(iso) {
  const d = new Date(iso);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

function formatDateShort(iso) {
  const d = new Date(iso);
  return `${pad2(d.getUTCDate())}.${pad2(d.getUTCMonth() + 1)}.${String(d.getUTCFullYear()).slice(2)}`;
}

function monthKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function monthTitle(key) {
  const [year, m] = key.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${year}`;
}

const shortMonth = (title) => title.split(' ')[0].slice(0, 3);

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function share(count, total) {
  if (!total) return '';
  const pct = (count / total) * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

const periodSpan = (from, to) => {
  const a = new Date(from);
  const b = new Date(to);
  return `${pad2(a.getUTCDate())}.${pad2(a.getUTCMonth() + 1)} — ${formatDateShort(b)}`;
};

const clock = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
};

const tickLabel = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','));

export {
  MONTH_NAMES,
  clock,
  esc,
  formatDate,
  formatDateShort,
  json,
  monthKey,
  monthTitle,
  pad2,
  periodSpan,
  plural,
  share,
  shortMonth,
  tickLabel,
};
