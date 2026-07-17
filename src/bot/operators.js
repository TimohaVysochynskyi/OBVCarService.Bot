// Display aliases for operators. Maps a raw manager_name (as stored on calls — a Binotel name
// or a bare number/phone) to a friendly display name shown everywhere in the bot (archive list,
// stats, call detail, reports).
//
// Only the RENDERING is aliased: DB rows and callback data keep the raw value, so grouping,
// queries and attribution are untouched and the mapping is fully reversible. Add more via the
// OPERATOR_ALIASES env var ("num=Name" pairs, comma-separated), which merges over the defaults.
//
// Default: the director's mobile 0674738200 shows as "Богдан" instead of a bare number.
const DEFAULT_ALIASES = { '0674738200': 'Богдан' };

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

// Raw manager_name -> friendly name (or the raw value unchanged when there's no alias).
function displayName(name) {
  return (name != null && OPERATOR_ALIASES[name]) || name;
}

// Whether this raw name has a human alias (used to decide the 👤 vs ☎️ label).
function hasAlias(name) {
  return name != null && Object.prototype.hasOwnProperty.call(OPERATOR_ALIASES, name);
}

export { displayName, hasAlias, OPERATOR_ALIASES };
