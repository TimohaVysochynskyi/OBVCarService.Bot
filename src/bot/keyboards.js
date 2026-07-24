import { InlineKeyboard } from "grammy";
import { shortDate } from "./time.js";
import { displayName, hasAlias, formatPhone } from "./operators.js";
import { isAdmin, ROLES } from "./access.js";

const PERIODS = [
  ["day", "День"],
  ["week", "Тиждень"],
  ["month", "Місяць"],
  ["quarter", "Квартал"],
];

// The main menu is role-aware: admins (director/marketer) see everything, a manager sees their
// own report + the knowledge base, a mechanic sees only the knowledge base.
function mainMenu(role) {
  const kb = new InlineKeyboard();
  if (isAdmin(role)) {
    // "Файли" is intentionally NOT here — it lives only in the native "Menu" command list (/files).
    kb.text("📊 Статистика менеджера", "stat:pick")
      .row()
      .text("🗂 Архів розмов", "arch:pick")
      .row()
      .text("📚 База знань", "kb:ask")
      .row()
      .text("🔄 Звіт зараз", "report:now")
      .row()
      .text("👥 Ролі", "roles");
    return kb;
  }
  if (role === ROLES.MANAGER) {
    kb.text("📊 Моя статистика", "me:pick").row().text("📚 База знань", "kb:ask");
    return kb;
  }
  // mechanic (and any other limited role)
  kb.text("📚 База знань", "kb:ask");
  return kb;
}

function operatorLabel(name) {
  // Operators in the picker are personal numbers assigned to managers, so a named/aliased operator
  // gets the 📱 (mobile) label (client's request — visually "a personal number"). A phone-shaped
  // numeric name is shown as +380…; only a short shared extension (901/902) keeps ☎️ "Спільний".
  if (hasAlias(name)) return `📱 ${displayName(name)}`;
  if (/^[0-9]+$/.test(name)) {
    const phone = formatPhone(name);
    return phone !== name ? `📱 ${phone}` : `☎️ Спільний ${name}`;
  }
  return `📱 ${name}`;
}

// Telegram doesn't expose a text-align property for inline buttons - the client always centers
// the caption, and there's no way around that from the Bot API. As a best-effort approximation of
// left alignment, every label in the same list is padded to a common width with BRAILLE PATTERN
// BLANK (U+2800) - a printable "blank" character, not real whitespace, so it survives any trailing
// whitespace trimming the way a plain space wouldn't. The client then centers "text + padding" as
// one block, which visually shifts the real text toward the left edge instead of true center.
// Not pixel-perfect (proportional font; only relative to the longest label in THIS list, not the
// true screen edge), but reads much more like a left-aligned table than independently-centered rows.
const PAD_CHAR = '⠀';
function leftAlignLabels(labels) {
  const lengths = labels.map((l) => [...l].length);
  const maxLen = Math.max(0, ...lengths);
  return labels.map((l, i) => l + PAD_CHAR.repeat(Math.max(0, maxLen - lengths[i])));
}

// operators: [{ name, n, firstCall? }]. With { showDates: true } (Archive) each label gains the
// operator's active period — from their first processed call (proxy for when Binotel first saw
// the name) to today, e.g. "📱 Роман (175) — 01.02.25-01.02.26". Shared by every screen that lists
// operators (stats/archive/roles) so formatting - including the left-align approximation - stays
// in one place.
function operatorLabels(operators, { showDates = false } = {}) {
  const today = new Date();
  const raw = operators.map((o) => {
    let label = `${operatorLabel(o.name)} (${o.n})`;
    if (showDates && o.firstCall) label += ` — ${shortDate(o.firstCall)}-${shortDate(today)}`;
    return label;
  });
  return leftAlignLabels(raw);
}

// prefix is 'stat' or 'arch'; the operator name is the trailing segment of the callback data so
// it can contain anything except a colon (first names don't).
function operatorListKeyboard(operators, prefix, { showDates = false } = {}) {
  const kb = new InlineKeyboard();
  const labels = operatorLabels(operators, { showDates });
  operators.forEach((o, i) => kb.text(labels[i], `${prefix}:op:${o.name}`).row());
  kb.text("« Меню", "menu");
  return kb;
}

// makeData(period) -> callback_data; backData -> the "back" button callback.
function periodKeyboard(makeData, backData) {
  const kb = new InlineKeyboard();
  for (const [p, label] of PERIODS) kb.text(label, makeData(p));
  kb.row().text("« Назад", backData);
  return kb;
}

export { mainMenu, operatorListKeyboard, operatorLabels, periodKeyboard, operatorLabel, PERIODS };
