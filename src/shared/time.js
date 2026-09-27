
const TZ = 'Europe/Kyiv';

function kyivParts(date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const m = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour),
    minute: Number(m.minute),
    dateStr: `${m.year}-${m.month}-${m.day}`,
    hhmm: `${m.hour}:${m.minute}`,
  };
}

function kyivWeekday(date) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(date);
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd];
}

function kyivOffsetMinutes(date) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value;
  const mt = s.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!mt) return 180;
  const h = Number(mt[1]);
  const min = mt[2] ? Number(mt[2]) : 0;
  return h * 60 + (h < 0 ? -min : min);
}

function kyivMidnightUtc(year, month, day) {
  const approx = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const off = kyivOffsetMinutes(approx);
  return new Date(approx.getTime() - off * 60 * 1000);
}

function shiftKyivDate({ year, month, day }, deltaDays) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function startOfDay(now) {
  const p = kyivParts(now);
  return kyivMidnightUtc(p.year, p.month, p.day);
}

function startOfWeek(now) {
  const p = kyivParts(now);
  const monday = shiftKyivDate(p, -(kyivWeekday(now) - 1));
  return kyivMidnightUtc(monday.year, monday.month, monday.day);
}

function startOfMonth(now) {
  const p = kyivParts(now);
  return kyivMidnightUtc(p.year, p.month, 1);
}

function startOfQuarter(now) {
  const p = kyivParts(now);
  const qMonth = Math.floor((p.month - 1) / 3) * 3 + 1;
  return kyivMidnightUtc(p.year, qMonth, 1);
}

const PERIODS = {
  day: { label: 'сьогодні', start: startOfDay },
  week: { label: 'цей тиждень (з пн)', start: startOfWeek },
  month: { label: 'цей місяць', start: startOfMonth },
  quarter: { label: 'цей квартал', start: startOfQuarter },
};

function periodRange(period, now = new Date()) {
  const def = PERIODS[period] || PERIODS.week;
  return { start: def.start(now), end: now, label: def.label };
}

function slotMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins > 0 && mins < 24 * 60 ? mins : null;
}

function kyivDaySegments(now, slots = []) {
  const p = kyivParts(now);
  const midnight = kyivMidnightUtc(p.year, p.month, p.day);
  const next = shiftKyivDate(p, 1);
  const nextMidnight = kyivMidnightUtc(next.year, next.month, next.day);
  const mins = [...new Set(slots.map(slotMinutes).filter((x) => x != null))].sort((a, b) => a - b);
  const bounds = [midnight, ...mins.map((x) => new Date(midnight.getTime() + x * 60000)), nextMidnight];
  const segs = [];
  for (let i = 0; i < bounds.length - 1; i += 1) segs.push({ start: bounds[i], end: bounds[i + 1] });
  return segs;
}

function formatKyiv(date) {
  const p = kyivParts(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.day)}.${pad(p.month)}.${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

function shortDate(date) {
  const p = kyivParts(new Date(date));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.day)}.${pad(p.month)}.${String(p.year).slice(-2)}`;
}

export { kyivParts, periodRange, startOfDay, kyivDaySegments, formatKyiv, shortDate };
