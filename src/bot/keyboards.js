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

function mainMenu(role) {
  const kb = new InlineKeyboard();
  if (isAdmin(role)) {
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
  kb.text("📚 База знань", "kb:ask");
  return kb;
}

function operatorLabel(name) {
  if (hasAlias(name)) return `📱 ${displayName(name)}`;
  if (/^[0-9]+$/.test(name)) {
    const phone = formatPhone(name);
    return phone !== name ? `📱 ${phone}` : `☎️ Спільний ${name}`;
  }
  return `📱 ${name}`;
}

function operatorLabels(operators, { showDates = false } = {}) {
  const today = new Date();
  return operators.map((o) => {
    let label = `${operatorLabel(o.name)} (${o.n})`;
    if (showDates && o.firstCall) label += ` — ${shortDate(o.firstCall)}-${shortDate(today)}`;
    return label;
  });
}

function operatorListKeyboard(operators, prefix, { showDates = false } = {}) {
  const kb = new InlineKeyboard();
  const labels = operatorLabels(operators, { showDates });
  operators.forEach((o, i) => kb.text(labels[i], `${prefix}:op:${o.name}`).row());
  kb.text("« Назад до меню", "menu");
  return kb;
}

function periodKeyboard(makeData, backData) {
  const kb = new InlineKeyboard();
  for (const [p, label] of PERIODS) kb.text(label, makeData(p));
  kb.row().text("« Назад", backData);
  return kb;
}

export { mainMenu, operatorListKeyboard, operatorLabels, periodKeyboard, operatorLabel, PERIODS };
