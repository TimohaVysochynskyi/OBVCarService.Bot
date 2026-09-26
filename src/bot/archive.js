import { InlineKeyboard, InputFile } from "grammy";
import { appError } from "../core/errors.js";
import {
  getOperators,
  countOperatorCalls,
  listOperatorCalls,
  getOperatorPurposeCounts,
  getCallByGeneralId,
} from "../core/store.js";
import { getRecordingForCall } from "../core/audioStore.js";
import { operatorListKeyboard, operatorLabel } from "./keyboards.js";
import { displayName, formatPhone } from "./operators.js";
import { formatDialogue } from "./dialogue.js";
import { timecodedDialogue } from "../core/dialogueMetrics.js";
import { NON_SALES_PURPOSES } from "../core/callPurpose.js";
import { DIRECTION_LABELS } from "../core/callDirection.js";
import { kyivParts, formatKyiv } from "./time.js";
import { sendLong, withProgress, showScreen } from "./ui.js";

const PAGE = 8;
const JUMP = PAGE * 2;

const looksDiarized = (t) => /(^|\n)\s*(Менеджер|Клієнт)\s*:/.test(t || "");

const isNonSales = (p) => NON_SALES_PURPOSES.includes(p);

const CATEGORIES = [
  { key: "sales", icon: "💰", plural: "Угоди", one: "угода" },
  { key: "info", icon: "ℹ️", plural: "Інформаційні", one: "інформаційний" },
  { key: "personal", icon: "👤", plural: "Особисті", one: "особистий" },
  { key: "other", icon: "⚙️", plural: "Службові", one: "службовий" },
  { key: "none", icon: "❔", plural: "Інші", one: "інший" },
];
const categoryOf = (key) => CATEGORIES.find((c) => c.key === key) || null;
const purposeLabel = (p) => categoryOf(p || "none")?.one ?? "інший";

function shortKyiv(date) {
  const p = kyivParts(new Date(date));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(p.day)}.${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`;
}

async function archivePicker() {
  const operators = await getOperators();
  if (!operators.length) {
    return {
      text: "Поки немає оброблених дзвінків.",
      kb: new InlineKeyboard().text("« Назад до меню", "menu"),
    };
  }
  return {
    text: "🗂 Архів розмов — оберіть менеджера:",
    kb: operatorListKeyboard(operators, "arch", { showDates: true }),
  };
}

function registerArchive(bot) {
  bot.callbackQuery("arch:pick", async (ctx) => {
    const { text, kb } = await archivePicker();
    await ctx.answerCallbackQuery();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery(/^arch:op:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    await ctx.answerCallbackQuery();
    await showCategoryPicker(ctx, name);
  });

  bot.callbackQuery(/^arch:cat:(\w+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showArchivePage(ctx, ctx.match[2], ctx.match[1], 0);
  });

  bot.callbackQuery(/^arch:go:(\d+):(\w+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showArchivePage(ctx, ctx.match[3], ctx.match[2], Number(ctx.match[1]));
  });

  async function showCategoryPicker(ctx, name) {
    const counts = await getOperatorPurposeCounts(name);
    const available = CATEGORIES.filter((c) => counts[c.key] > 0);
    const kb = new InlineKeyboard();
    for (const c of available) {
      kb.text(`${c.icon} ${c.plural} (${counts[c.key]})`, `arch:cat:${c.key}:${name}`).row();
    }
    kb.text("« Назад до меню", "menu").text("« Менеджери", "arch:pick");
    const text = available.length
      ? `${operatorLabel(name)}\nОберіть категорію дзвінків:`
      : `${operatorLabel(name)}\nНемає оброблених дзвінків.`;
    await showScreen(ctx, text, kb);
  }

  async function showArchivePage(ctx, name, cat, offset) {
    const category = categoryOf(cat);
    if (!category) return;
    const total = await countOperatorCalls(name, cat);

    if (total === 0) {
      const back = new InlineKeyboard()
        .text("« Назад до меню", "menu")
        .text("« Категорії", `arch:op:${name}`);
      await showScreen(
        ctx,
        `${operatorLabel(name)} · ${category.icon} ${category.plural}\nНемає дзвінків у цій категорії.`,
        back,
      );
      return;
    }

    const calls = await listOperatorCalls(name, PAGE, offset, cat);
    const kb = new InlineKeyboard();
    for (const c of calls) {
      const btn = isNonSales(c.callPurpose)
        ? shortKyiv(c.startTime)
        : `${shortKyiv(c.startTime)} ${c.isSuccess ? "👍" : "👎"} бал ${c.communicationScore ?? "—"}`;
      kb.text(btn, `arch:call:${c.generalCallId}:${offset}:${cat}`).row();
    }
    const at = (o) => `arch:go:${o}:${cat}:${name}`;
    if (offset >= JUMP) kb.text("⏪", at(Math.max(0, offset - JUMP)));
    if (offset > 0) kb.text("◀", at(Math.max(0, offset - PAGE)));
    kb.text(`${offset + 1}–${Math.min(offset + PAGE, total)}`, "noop");
    if (offset + PAGE < total) kb.text("▶", at(offset + PAGE));
    if (offset + JUMP < total) kb.text("⏩", at(offset + JUMP));
    kb.row().text("« Назад до меню", "menu").text("« Категорії", `arch:op:${name}`);

    await showScreen(
      ctx,
      `${operatorLabel(name)} · ${category.icon} ${category.plural}\n` +
        `Усього дзвінків цього типу: ${total}\n\nОберіть дзвінок:`,
      kb,
    );
  }

  bot.callbackQuery(/^arch:call:(\d+):(\d+):(\w+)$/, async (ctx) => {
    const gid = ctx.match[1];
    const listOffset = Number(ctx.match[2]);
    const listCat = ctx.match[3];
    await ctx.answerCallbackQuery();
    const c = await getCallByGeneralId(gid);
    if (!c) {
      await ctx.reply("Дзвінок не знайдено.");
      return;
    }
    const listName = c.managerName;
    const evalLine = isNonSales(c.callPurpose)
      ? `Тип: ${purposeLabel(c.callPurpose)} (без оцінки продажів)`
      : `Успіх: ${c.isSuccess ? "так" : "ні"}, бал: ${c.communicationScore ?? "—"}, слабкий етап: ${c.weakestStage ?? "—"}`;
    const dir = DIRECTION_LABELS[c.direction];
    const header =
      `${dir ? `${dir.icon} ${dir.title} дзвінок — ${dir.about}` : "Напрямок дзвінка невідомий"}\n` +
      `📞 Телефон: ${c.clientNumber ? formatPhone(c.clientNumber) : "—"}\n` +
      `Клієнт: ${c.clientName || "Невідомо"}\n` +
      `Менеджер: ${displayName(c.managerName) ?? "—"}\n` +
      `Час: ${formatKyiv(new Date(c.startTime))}\n` +
      `Тривалість: ${c.durationSec ?? "—"} с\n` +
      evalLine;
    await sendLong(ctx.api, ctx.chat.id, header);
    if (Array.isArray(c.segments) && c.segments.length) {
      await sendLong(ctx.api, ctx.chat.id, `📝 Розмова:\n\n${timecodedDialogue(c.segments)}`);
    } else if (looksDiarized(c.transcript)) {
      await sendLong(ctx.api, ctx.chat.id, `📝 Розмова:\n\n${c.transcript}`);
    } else {
      let dialogue;
      try {
        dialogue = await withProgress(
          ctx.api,
          ctx.chat.id,
          "typing",
          () => formatDialogue(c.transcript),
          { notice: "⏳ Форматую розмову у діалог…" },
        );
      } catch (err) {
        console.error(`[bot] dialogue format ${gid} failed: ${err.message}`);
        dialogue = c.transcript || "(порожньо)";
      }
      await sendLong(ctx.api, ctx.chat.id, `📝 Розмова:\n\n${dialogue}`);
    }
    await ctx.reply("Аудіо запису:", {
      reply_markup: new InlineKeyboard()
        .text("🎧 Прослухати запис", `arch:play:${gid}`)
        .row()
        .text("« Назад до меню", "menu")
        .text("« Список", `arch:go:${listOffset}:${listCat}:${listName}`),
    });
  });

  bot.callbackQuery(/^arch:play:(.+)$/, async (ctx) => {
    const gid = ctx.match[1];
    await ctx.answerCallbackQuery({ text: "Готую аудіо…" });
    try {
      await withProgress(ctx.api, ctx.chat.id, "upload_voice", async () => {
        const audio = await getRecordingForCall(gid);
        if (!audio) throw appError("SYS-NOFILE");
        await ctx.replyWithAudio(new InputFile(audio.buffer, `dialog-${gid}.mp3`), {
          caption: `Запис дзвінка ${gid}`,
        });
      });
    } catch (err) {
      console.error(`[bot] аудіо дзвінка ${gid}: ${err.message}`);
      throw err;
    }
  });

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
}

export { registerArchive, archivePicker };
