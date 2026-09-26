const DEFAULT_ALIASES = {};

function parseAliases(raw) {
  const map = { ...DEFAULT_ALIASES };
  for (const pair of (raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key && val) map[key] = val;
  }
  return map;
}

const OPERATOR_ALIASES = parseAliases(process.env.OPERATOR_ALIASES);

function displayName(name) {
  return (name != null && OPERATOR_ALIASES[name]) || name;
}

function hasAlias(name) {
  return name != null && Object.prototype.hasOwnProperty.call(OPERATOR_ALIASES, name);
}

function formatPhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length <= 4) return String(raw ?? '');
  if (d.length === 12 && d.startsWith('380')) return `+${d}`;
  if (d.length === 10 && d.startsWith('0')) return `+38${d}`;
  if (d.length === 9) return `+380${d}`;
  return String(raw ?? '');
}

function formatLinePhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  let local = d;
  if (d.length === 12 && d.startsWith('380')) local = `0${d.slice(3)}`;
  else if (d.length === 9) local = `0${d}`;
  if (local.length !== 10 || !local.startsWith('0')) return String(raw ?? '');
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6, 8)} ${local.slice(8, 10)}`;
}

export { displayName, hasAlias, formatPhone, formatLinePhone, OPERATOR_ALIASES };
