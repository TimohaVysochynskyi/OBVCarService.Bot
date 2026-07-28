import { InlineKeyboard } from 'grammy';
import {
  getOperatorStats,
  getCallsForReport,
  getActiveOperatorsInRange,
  getRecipients,
  getReportTimes,
  getDeliveredSlots,
  markSlotDelivered,
  deleteOldManualTails,
} from '../core/store.js';
import { reduceFindings, mergeFindings, MAX_PHRASES, MIN_EVIDENCE } from './analyze.js';
import { assembleReport, collectRangeFindings } from './segments.js';
import { prepareClips, clipKey, sendClip } from './audioClip.js';
import { withProgress, sendLong } from './ui.js';
import { displayName } from './operators.js';
import { kyivParts, kyivDaySegments, startOfDay, formatKyiv, shortDate } from './time.js';

// Shown (verbatim, owner's wording) when a period yielded no findings because the manager made no
// sales calls in it — the numeric header above it still carries the volume of work they did.
const NO_SALES_TEXT =
  'За цей період менеджер не здійснював продажних дзвінків, тому оцінка продажних навичок наразі неможлива. Вище наведені кількісні показники роботи.';

// Evidence-first report delivery (Telegram text + audio clips). A report is a set of BLOCKS — each
// block is one analysed time segment (a frozen 'scheduled' segment reused from report_segments, or a
// live 'manual_tail'/'live' block). The costly reduce is cached per segment (src/bot/segments.js), so
// repeated / incremental reports reuse it instead of re-analysing from scratch.
//
// EVERY delivery path (manual "Звіт зараз", the stats.js per-manager drill-down, scheduled auto-
// reports) sends the SAME shape: just the numeric header, with "🔽 Розгорнути" (findings +
// audio) and "💬 Рекомендації" (phrases) buttons — never the full wall of text+audio inline. One
// consistent UX everywhere a report appears (2026-07-24, by request).

const ERROR_ICON = '❌';
const STRENGTH_ICON = '✅';

// Legacy single-pass build (used for the live multi-day path, e.g. week/month "Статистика
// менеджера"): one live reduce over the whole period, wrapped as a single block so delivery is
// uniform with the segmented path.
async function buildManagerEvidenceReport(name, start, end) {
  const stats = await getOperatorStats(name, start, end);
  if (!stats.callCount) return null;
  const calls = await getCallsForReport(name, start, end);
  const { findings, phrases } = await reduceFindings(name, calls, stats);
  return { name, stats, blocks: [{ start, end, kind: 'live', findings, phrases }], phrases, start, end };
}

// Multi-day period (week / month / quarter). Every DAY of the range is analysed and cached
// (src/bot/segments.js: collectRangeFindings), then the per-day findings are MERGED into one
// coherent list for the whole period (analyze.js: mergeFindings) — one list, not one block per day.
//
// This replaced the old 'trend' mode, which printed a per-day numeric list and only reused
// already-frozen segments, so a period nobody had reported on yet produced "ще немає заморожених
// відрізків аналізу" instead of an analysis. Weeks/months of NUMBERS live on the "Динаміка" screen;
// this report is about patterns.
//
// analyze:false (quarter only) keeps it reuse-only — a quarter can span ~90 days, which is too much
// to analyse on a button press — and reports honestly how much of it is covered.
async function buildRangeReport(name, start, end, { analyze = true } = {}) {
  const collected = await collectRangeFindings(name, start, end, { analyze });
  if (!collected) return null;
  const findings = await mergeFindings(name, collected.findings);
  return {
    name,
    stats: collected.stats,
    blocks: [{ start, end, kind: 'range', findings, phrases: collected.phrases }],
    phrases: collected.phrases,
    start,
    end,
    coverage: { days: collected.days, analysed: collected.analysedDays, missing: collected.missingDays },
    reuseOnly: !analyze,
  };
}

// Build a report for one manager without delivering it. mode:
//   'daily'       — assemble from the frozen per-segment cache + a live tail (today's flow);
//   'range'       — multi-day (week/month): analyse every day that isn't cached yet, merge into one list;
//   'range_reuse' — same, but reuse-ONLY (quarter: too many days to analyse on a button press);
//   'live'        — legacy single live reduce over the whole period (fallback, no current caller).
function buildReportByMode(mode, name, start, end) {
  if (mode === 'range') return buildRangeReport(name, start, end, { analyze: true });
  if (mode === 'range_reuse') return buildRangeReport(name, start, end, { analyze: false });
  if (mode === 'live') return buildManagerEvidenceReport(name, start, end);
  return assembleReport(name, start, end);
}

const hm = (date) => {
  const p = kyivParts(new Date(date));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.hour)}:${pad(p.minute)}`;
};

// Numeric header. Conversion / score / weakest stage are over SALES-relevant calls. Deliberately
// compact (client's request, 2026-07-24): no info-call count, no "з N продажних" on Записів, no
// "(продажні)" qualifiers - the reader already knows these numbers are sales-scoped.
function headerText(report) {
  const { name, stats, start, end } = report;
  const sales = stats.salesCount ?? 0;
  const rate = sales ? Math.round((stats.successCount / sales) * 100) : 0;
  // Reuse-only periods (quarter) must not pretend to be complete: say how many days actually carry
  // an analysis, so nobody reads "no patterns" as "no problems".
  const coverage =
    report.reuseOnly && report.coverage?.missing
      ? `\n\n_Аналіз є за ${report.coverage.analysed} з ${report.coverage.days} днів періоду — картина може бути неповною._`
      : '';
  return (
    `📊 *Доказовий звіт* — ${displayName(name)}\n` +
    `${formatKyiv(start)} – ${formatKyiv(end)}\n\n` +
    `Дзвінків: *${stats.callCount}* (продажних: ${sales})\n` +
    `Записів: *${stats.successCount}* (${rate}%)\n` +
    `Середній бал: *${stats.avgScore ?? '—'}*\n` +
    `Найслабший етап: *${stats.topWeakStage ?? '—'}*${coverage}`
  );
}

// Subheader shown before a block's findings when a report has more than one non-empty block
// (so the owner sees which time segment each finding set belongs to — the basis of growth tracking).
function blockHeader(b) {
  const range = `${hm(b.start)}–${hm(b.end)}`;
  if (b.kind === 'manual_tail') return `🕒 Поточний відрізок ${range} (свіжий аналіз)`;
  return `🗓 Відрізок ${shortDate(b.start)} ${range}`;
}

// Plain text (no markdown) so arbitrary quote characters (_ * [ …) never break rendering.
function findingText(f, idx) {
  const icon = f.type === 'error' ? ERROR_ICON : STRENGTH_ICON;
  const lines = [`${icon} ${idx}. ${f.claim}`, ''];
  lines.push(`Чому це впливає на записи: ${f.why}`);
  lines.push(`Що зробити: ${f.action}`);
  lines.push('');
  lines.push(`Докази (${f.evidence.length}):`);
  f.evidence.forEach((ev, i) => {
    lines.push(`${i + 1}. «${ev.quote}» — ${formatKyiv(new Date(ev.startTime))}`);
    // Code-measured context (interruption / long pause). Without it the quote reads as an ordinary
    // manager line and the director can't see WHY it proves the claim — the proof is the turn order
    // and the timecodes, not the sentence itself.
    if (ev.note) lines.push(`   ↳ ${ev.note}`);
  });
  return lines.join('\n');
}

async function sendPhrases(api, chatId, phrases, { replyToMessageId } = {}) {
  if (!phrases?.length) return;
  await sendLong(
    api,
    chatId,
    '💬 Готові формулювання (зразки, НЕ цитати):\n\n' + phrases.map((p, i) => `${i + 1}. ${p}`).join('\n'),
    { replyToMessageId }
  );
}

// The numeric header as one logical unit. replyMarkup is attached to the LAST piece sent —
// the "🔽 Розгорнути"/"💬 Рекомендації" buttons every report is delivered with.
async function sendReportSummary(api, chatId, report, { replyMarkup } = {}) {
  await sendLong(api, chatId, headerText(report), { parseMode: 'Markdown', replyMarkup });
}

// Findings (blocks) + audio clips, or the "nothing found" fallback - the part hidden behind
// "🔽 Розгорнути". clips (optional Map from prepareClips) carries pre-cut audio Buffers keyed by
// clipKey; each negative finding's quotes are followed by their clip. replyToMessageId threads every
// message sent here back to the report message the button was clicked on (see registerReportActions).
async function sendReportFindings(api, chatId, report, { clips, replyToMessageId } = {}) {
  const blocks = (report.blocks || []).filter((b) => (b.findings || []).length);
  if (!blocks.length) {
    const sales = report.stats.salesCount ?? 0;
    let msg;
    if (sales === 0) {
      // Owner-specified wording for the common case: nothing to judge because there were no sales
      // calls at all. Kept separate from the "there WERE sales calls, just no repeated pattern" case
      // below — claiming "no sales calls" when there were some would simply be false.
      msg = NO_SALES_TEXT;
    } else if (report.reuseOnly && !report.coverage?.analysed) {
      msg =
        '📄 За цей період ще немає готового аналізу. Відкрийте звіт за тиждень або місяць — вони аналізують період одразу, і квартал далі спиратиметься на ці результати.';
    } else {
      msg = `✅ За цей період не знайдено повторюваних патернів (з ≥${MIN_EVIDENCE} підтвердженими прикладами) — критичних системних проблем у продажах не зафіксовано. Вище — числові показники.`;
    }
    await sendLong(api, chatId, msg, { replyToMessageId });
    return;
  }

  const multi = blocks.length > 1;
  for (const b of blocks) {
    if (multi) await sendLong(api, chatId, blockHeader(b), { replyToMessageId });
    let idx = 0;
    for (const f of b.findings) {
      idx += 1;
      await sendLong(api, chatId, findingText(f, idx), { replyToMessageId });
      // Audio only for negative findings (client's choice), and only for quotes that have a timecode.
      if (clips && f.type === 'error') {
        for (const ev of f.evidence) {
          if (ev.start == null) continue;
          const buf = clips.get(clipKey(ev.callId, ev.start, ev.end));
          if (buf) await sendClip(api, chatId, buf, ev, { replyToMessageId });
        }
      }
    }
  }
}

// expandKey encodes exactly what a later "🔽 Розгорнути"/"💬 Рекомендації" click needs to re-derive
// this SAME report via buildReportByMode - cheap for 'daily'/'range' (reads the cached
// report_segments cache rather than re-running the LLM reduce; see registerReportActions).
const expandKeyOf = (name, start, end, mode) =>
  `${mode}:${Math.floor(start.getTime() / 1000)}:${Math.floor(end.getTime() / 1000)}:${name}`;

// Send a fully-built report to ONE chat: ONLY the header/trend, with "🔽 Розгорнути" and
// "💬 Рекомендації" buttons attached - never the findings/audio/phrases inline.
async function deliverReport(api, chatId, report, { expandKey }) {
  const kb = new InlineKeyboard()
    .text('🔽 Розгорнути', `report:exp:${expandKey}`)
    .text('💬 Рекомендації', `report:phr:${expandKey}`);
  await sendReportSummary(api, chatId, report, { replyMarkup: kb });
}

// Build + deliver one manager's report to one chat. Audio is never cut here - deferred entirely to
// the "🔽 Розгорнути" click, so nothing is downloaded/cut until someone actually asks to see it.
async function deliverManagerReport(api, chatId, name, start, end, { mode = 'daily' } = {}) {
  const report = await buildReportByMode(mode, name, start, end);
  if (!report) return { empty: true };
  await deliverReport(api, chatId, report, { expandKey: expandKeyOf(name, start, end, mode) });
  return { sent: true };
}

// Manual "Звіт зараз": today so far, every active manager, delivered to the requester. Uses the
// segmented path → reuses today's frozen scheduled segments + a deduped live tail, so a repeated
// click costs (almost) nothing. Does NOT touch the scheduler state.
async function sendManualReport(api, chatId) {
  const end = new Date();
  const start = startOfDay(end);
  const res = await withProgress(
    api,
    chatId,
    'typing',
    async () => {
      const managers = await getActiveOperatorsInRange(start, end);
      if (!managers.length) return { empty: true };
      for (const m of managers) {
        await deliverManagerReport(api, chatId, m.name, start, end, { mode: 'daily' });
      }
      return { sent: true };
    },
    { notice: '⏳ Бот формує доказовий звіт (аналіз), це може зайняти деякий час…' }
  );
  if (res.empty) await api.sendMessage(chatId, 'За сьогодні ще немає оброблених дзвінків для звіту.');
  return res;
}

// expandKey = "<mode>:<startUnix>:<endUnix>:<name>" (name is the trailing segment - can't contain ':').
function parseExpandKey(raw) {
  const m = /^(daily|range|range_reuse|live):(\d+):(\d+):(.+)$/.exec(raw || '');
  if (!m) return null;
  return { mode: m[1], start: new Date(Number(m[2]) * 1000), end: new Date(Number(m[3]) * 1000), name: m[4] };
}

// Handlers for every report's "🔽 Розгорнути"/"💬 Рекомендації" buttons. Both re-derive the report
// from expandKey via buildReportByMode - cheap for 'daily'/'range' (reads the cached report_segments
// cache rather than re-running the LLM reduce). Audio clips are NOT persisted anywhere (see
// audioClip.js), so "Розгорнути" re-cuts them at click time - the same re-fetch-on-click pattern
// archive.js already uses for "🎧 Прослухати запис".
//
// Content is sent as a Telegram REPLY to the exact message the clicked button lives on
// (ctx.callbackQuery.message.message_id) so it visually threads under THAT report, not just at the
// bottom of the chat - several managers'/several reports' messages can be interleaved in the same
// chat by the time someone clicks, so "just append at the end" would land under the wrong report.
function registerReportActions(bot) {
  bot.callbackQuery(/^report:exp:(.+)$/, async (ctx) => {
    const parsed = parseExpandKey(ctx.match[1]);
    const replyToMessageId = ctx.callbackQuery.message?.message_id;
    const replyParameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
    await ctx.answerCallbackQuery();
    if (!parsed) return;
    await withProgress(
      ctx.api,
      ctx.chat.id,
      'upload_voice',
      async () => {
        const report = await buildReportByMode(parsed.mode, parsed.name, parsed.start, parsed.end);
        if (!report) {
          await ctx.reply('Дані звіту вже недоступні.', { reply_parameters: replyParameters });
          return;
        }
        const clips = await prepareClips(report);
        await sendReportFindings(ctx.api, ctx.chat.id, report, { clips, replyToMessageId });
      },
      { notice: '⏳ Готую деталі та аудіо-докази…' }
    );
  });

  bot.callbackQuery(/^report:phr:(.+)$/, async (ctx) => {
    const parsed = parseExpandKey(ctx.match[1]);
    const replyToMessageId = ctx.callbackQuery.message?.message_id;
    const replyParameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
    await ctx.answerCallbackQuery();
    if (!parsed) return;
    const report = await buildReportByMode(parsed.mode, parsed.name, parsed.start, parsed.end);
    if (!report) {
      await ctx.reply('Дані звіту вже недоступні.', { reply_parameters: replyParameters });
      return;
    }
    if (!report.phrases?.length) {
      // Phrases are a side-product of the SAME reduce call that produces findings (see
      // analyze.js: reduceFindingsConsistent) - if there weren't enough tagged sales-call
      // behaviours to cluster into findings (MIN_EVIDENCE), there are none here either. Not a
      // bug: expect this whenever "Розгорнути" also shows "нічого не знайдено" for the period.
      await ctx.reply(
        'Для цього періоду немає готових формулювань — замало продажних дзвінків із зафіксованою поведінкою (той самий поріг, що й для знахідок).',
        { reply_parameters: replyParameters }
      );
      return;
    }
    await sendPhrases(ctx.api, ctx.chat.id, report.phrases, { replyToMessageId });
  });
}

// Deliver one completed day-bounded segment [start, end] to every recipient. Builds the report
// (which computes+freezes the 'scheduled' segment via assembleReport) ONCE per manager, then fans
// out - collapsed, same as every other delivery path. A failed send to one recipient doesn't block
// others.
async function sendScheduledSlot(api, start, end) {
  const recipients = await getRecipients('report');
  if (recipients.length === 0) {
    console.warn('[bot] scheduled report: no recipients configured (Налаштування) - not sent');
    return;
  }
  const managers = await getActiveOperatorsInRange(start, end);
  for (const m of managers) {
    const report = await assembleReport(m.name, start, end);
    if (!report) continue;
    const expandKey = expandKeyOf(m.name, start, end, 'daily');
    for (const r of recipients) {
      try {
        await deliverReport(api, r.id, report, { expandKey });
      } catch (err) {
        console.error(`[bot] scheduled report to ${r.id} failed: ${err.message}`);
      }
    }
  }
}

let running = false;

// Day-bounded scheduler. On each tick, for each configured slot today whose time (+ grace) has
// passed and that hasn't been delivered yet, deliver the segment that closes at that slot
// ([previous boundary, slot]). The grace window lets late pending-call retries land before the
// segment is frozen; a slot that was missed (bot down) is still delivered when it comes back up.
async function maybeSendScheduledReport(api) {
  const now = new Date();
  const slots = await getReportTimes();
  if (!slots.length) return;
  if (running) return;

  const graceMs = Number(process.env.SEGMENT_GRACE_MIN || 10) * 60000;
  const { dateStr } = kyivParts(now);
  const daySegs = kyivDaySegments(now, slots);
  const delivered = await getDeliveredSlots();

  running = true;
  try {
    for (const hhmm of slots) {
      const seg = daySegs.find((s) => kyivParts(s.end).hhmm === hhmm);
      if (!seg) continue; // slot not a valid boundary today
      if (now.getTime() < seg.end.getTime() + graceMs) continue; // within grace → wait
      const slotKey = `${dateStr}-${hhmm}`;
      if (delivered.includes(slotKey)) continue;

      console.log(`[bot] scheduled slot ${slotKey}: ${seg.start.toISOString()} -> ${seg.end.toISOString()}`);
      await sendScheduledSlot(api, seg.start, seg.end);
      await markSlotDelivered(slotKey);
    }
    // GC ephemeral tails older than 2 days (scheduled segments are never removed).
    await deleteOldManualTails(new Date(Date.now() - 2 * 24 * 3600 * 1000)).catch(() => {});
  } finally {
    running = false;
  }
}

// Both the times and the recipients are read from the DB on every tick (managed in /settings), so
// the scheduler always runs — no env to configure. With no times/recipients set it simply skips.
function startScheduler(api) {
  console.log('[bot] report scheduler on (day-bounded segments, grace, times+recipients from /settings, Kyiv)');
  setInterval(() => {
    maybeSendScheduledReport(api).catch((e) => console.error(`[bot] scheduled report error: ${e.message}`));
  }, 30000);
}

export { buildManagerEvidenceReport, deliverManagerReport, sendManualReport, startScheduler, registerReportActions };
