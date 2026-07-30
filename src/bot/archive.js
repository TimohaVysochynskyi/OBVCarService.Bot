import { InlineKeyboard, InputFile } from "grammy";
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
import { kyivParts, formatKyiv } from "./time.js";
import { sendLong, withProgress, showScreen } from "./ui.js";

const PAGE = 8;
// Jump size for the ⏪/⏩ buttons — two pages at a time, on top of the single-page ◀/▶.
const JUMP = PAGE * 2;

// A transcript ingested via ElevenLabs is already a "Менеджер:/Клієнт:" dialogue — show it as is,
// instantly. Only the older/plain (OpenAI-fallback) transcripts need on-demand formatting.
const looksDiarized = (t) => /(^|\n)\s*(Менеджер|Клієнт)\s*:/.test(t || "");

// Non-sales calls (info/other) carry no effectiveness score — the ingest deliberately skips
// scoring them. Show a neutral purpose tag instead of a misleading 👎/бал. Sales calls (and
// legacy rows with a NULL purpose, treated as sales) keep the success/score display.
const isNonSales = (p) => p === "other" || p === "info";

// The four archive categories (calls.call_purpose; 'none' = NULL, i.e. ingested before purpose
// detection or MAP failure). Each gets its OWN icon: the picker shows them side by side, so the old
// shared ℹ️ for both info and other made two different categories look like one.
// NB: a sales-opportunity call is called "угода" everywhere the user can see it, never
// "продажний" — that adjective also means "venal/corrupt" in Ukrainian (owner's call, 2026-07-28).
// The DB value stays 'sales' (internal).
const CATEGORIES = [
  { key: "sales", icon: "💰", plural: "Угоди", one: "угода" },
  { key: "info", icon: "ℹ️", plural: "Інформаційні", one: "інформаційний" },
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

// Content for the "choose a manager" screen - reused by the inline button, the /archive
// command, and the quick-keyboard button.
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

  // A manager's history is browsed BY CATEGORY: opening a manager shows the category picker, and
  // only then the (paginated) call list of that one category, oldest first. Categories with no
  // calls aren't offered at all. There is still no period-picker step - pagination handles browsing.
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
    // Menu on the LEFT, the step-back on the RIGHT — one consistent order on every screen (owner's
    // request); mixing the two sides is what made the navigation feel random.
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
      // No category tag on the button: we are already INSIDE that category (shown in the header),
      // so repeating "інформаційний" on every row was pure noise. Sales calls still carry their
      // outcome, which is the thing that differs between them.
      const btn = isNonSales(c.callPurpose)
        ? shortKyiv(c.startTime)
        : `${shortKyiv(c.startTime)} ${c.isSuccess ? "👍" : "👎"} бал ${c.communicationScore ?? "—"}`;
      // offset + category are carried along so the call-detail screen's "« Список" button returns
      // to the exact page of the exact category being browsed. The manager NAME is deliberately not
      // included: callback_data is capped at 64 BYTES and a long Cyrillic name (2 bytes/char) can
      // blow that budget, which makes Telegram reject the whole keyboard. The detail screen reads
      // the name off the call row it loads anyway.
      kb.text(btn, `arch:call:${c.generalCallId}:${offset}:${cat}`).row();
    }
    // Pagination: ⏪/⏩ jump two pages, ◀/▶ one. Each is shown only when it actually lands somewhere
    // new, so no two visible arrows lead to the same page. Calls are listed OLDEST FIRST, so paging
    // RIGHT moves forward in time towards the newest (owner's request) — the counter shows only the
    // current window; the total lives in the message above, where there is room to label it.
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
    // The internal Binotel call id is deliberately NOT shown: it looks like a phone number and was
    // read as one. The client's actual phone leads instead, and "Ім'я" is whatever the CRM has them
    // labelled as ("Невідомо" when nobody ever named them).
    const header =
      `📞 Телефон: ${c.clientNumber ? formatPhone(c.clientNumber) : "—"}\n` +
      `Клієнт: ${c.clientName || "Невідомо"}\n` +
      `Менеджер: ${displayName(c.managerName) ?? "—"}\n` +
      `Час: ${formatKyiv(new Date(c.startTime))}\n` +
      `Тривалість: ${c.durationSec ?? "—"} с\n` +
      evalLine;
    // Plain text: the header carries no markup of its own any more, and client/manager names
    // routinely contain characters (_ * [) that would break Markdown parsing.
    await sendLong(ctx.api, ctx.chat.id, header);
    if (Array.isArray(c.segments) && c.segments.length) {
      // Timecoded turns ("00:12 Менеджер: …") rendered from calls.segments on the fly. The stored
      // transcript is deliberately left untouched — quote matching for the evidence report
      // (core/quoteMatch.js) runs against it, and prefixing every line would break that. Timecodes
      // let the director see how fast the manager reacts to each question.
      await sendLong(ctx.api, ctx.chat.id, `📝 Розмова:\n\n${timecodedDialogue(c.segments)}`);
    } else if (looksDiarized(c.transcript)) {
      // Diarized text without timecodes (older rows) — show instantly, no extra request.
      await sendLong(ctx.api, ctx.chat.id, `📝 Розмова:\n\n${c.transcript}`);
    } else {
      // Older/plain transcript (pre-ElevenLabs or OpenAI fallback): format on-demand (~10-20s).
      // On failure fall back to raw text so the call is always viewable.
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
      // Recordings are archived locally at ingest (core/audioStore.js), so this is normally just a
      // disk read + upload. Calls from before archiving fall back to Binotel (and are archived on
      // the way), which is the slow path - keep the "надсилає аудіо" indicator alive throughout.
      await withProgress(ctx.api, ctx.chat.id, "upload_voice", async () => {
        const audio = await getRecordingForCall(gid);
        if (!audio) throw new Error("запис недоступний");
        await ctx.replyWithAudio(new InputFile(audio.buffer, `dialog-${gid}.mp3`), {
          caption: `Запис дзвінка ${gid}`,
        });
      });
    } catch (err) {
      console.error(`[bot] audio for ${gid} failed: ${err.message}`);
      await ctx.reply(`Не вдалося надіслати аудіо: ${err.message}`);
    }
  });

  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
}

export { registerArchive, archivePicker };
