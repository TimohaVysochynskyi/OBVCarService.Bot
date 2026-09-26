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
  getBlockedCalls,
} from '../core/store.js';
import { reduceFindings, mergeFindings, MAX_PHRASES, MIN_EVIDENCE } from './analyze.js';
import { assembleReport, collectRangeFindings } from './segments.js';
import { prepareClips, clipKey, sendClip } from './audioClip.js';
import { noteIssue } from '../core/errorLog.js';
import { NOTICES } from '../core/errorTexts.js';
import { BLOCKER_LABELS } from '../core/dealBlocker.js';
import { withProgress, sendLong } from './ui.js';
import { displayName, formatPhone } from './operators.js';
import { kyivParts, kyivDaySegments, startOfDay, formatKyiv, shortDate } from './time.js';

const NO_SALES_TEXT =
  'За цей період менеджер не мав дзвінків-угод, тому оцінка навичок продажу наразі неможлива. Вище наведені кількісні показники роботи.';


const ERROR_ICON = '❌';
const STRENGTH_ICON = '✅';

async function buildManagerEvidenceReport(name, start, end) {
  const stats = await getOperatorStats(name, start, end);
  if (!stats.callCount) return null;
  const calls = await getCallsForReport(name, start, end);
  const { findings, phrases } = await reduceFindings(name, calls, stats);
  return { name, stats, blocks: [{ start, end, kind: 'live', findings, phrases }], phrases, start, end };
}

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

function headerText(report) {
  const { name, stats, start, end } = report;
  const sales = stats.salesCount ?? 0;
  const reachable = stats.reachableCount == null ? sales : stats.reachableCount;
  const rate = reachable ? Math.round((stats.successCount / reachable) * 100) : 0;
  const blocked = stats.blockedCount ?? 0;
  const blockedBlock = blocked
    ? `\n\n🚧 *Незакриті не з вини менеджера: ${blocked}*\n` +
      [
        stats.blockedNoSlot ? `• Черга — ${stats.blockedNoSlot} (СТО було забите)` : null,
        stats.blockedNoParts ? `• Нема деталей — ${stats.blockedNoParts} (запчастину не дістати)` : null,
        stats.blockedOutOfScope ? `• Не обслуговуємо — ${stats.blockedOutOfScope} (такого не робимо)` : null,
      ]
        .filter(Boolean)
        .join('\n') +
      `\n_Ці дзвінки не враховані в конверсії._`
    : '';
  const introChecked = stats.introChecked ?? 0;
  const noName = stats.introNoName ?? 0;
  const noCompany = stats.introNoCompany ?? 0;
  const introBlock =
    introChecked && (noName || noCompany)
      ? `\n\n🙋 *Не представився* (зі своїх ${introChecked} дзвінків)\n` +
        [
          noName ? `• не назвав своє імʼя — ${noName}` : null,
          noCompany ? `• не назвав сервіс — ${noCompany}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      : '';
  const coverage =
    report.reuseOnly && report.coverage?.missing
      ? `\n\n_Аналіз є за ${report.coverage.analysed} з ${report.coverage.days} днів періоду — картина може бути неповною._`
      : '';
  const lines = [
    `📊 *Доказовий звіт* — ${displayName(name)}`,
    `${formatKyiv(start)} – ${formatKyiv(end)}`,
    '',
    `Дзвінків за період: *${stats.callCount}*, з них угод: *${sales}*.`,
  ];

  if (!stats.callCount) {
    lines.push('', '_Жодного дзвінка за цей період не було._');
  } else if (!sales) {
    lines.push(
      '',
      '_Жодної угоди за цей період не було — усі розмови інформаційні або службові._',
      '_Оцінювати роботу з продажу тут немає на чому._'
    );
  } else if (!reachable) {
    lines.push(
      '',
      '_Усі угоди періоду СТО взяти не могло, тож конверсію рахувати немає з чого._'
    );
  } else {
    lines.push(`Записались: *${stats.successCount}* з ${reachable} (${rate}%).`);
    lines.push(
      stats.avgScore == null
        ? 'Середній бал розмови: ще не порахований.'
        : `Середній бал розмови: *${stats.avgScore}* з 10.`
    );
    lines.push(
      stats.topWeakStage
        ? `Найслабший етап: *${stats.topWeakStage}*.`
        : 'Найслабший етап: не визначився.'
    );
  }

  return lines.join(`
`) + blockedBlock + introBlock + coverage;
}

function blockHeader(b) {
  const range = `${hm(b.start)}–${hm(b.end)}`;
  if (b.kind === 'manual_tail') return `🕒 Поточний відрізок ${range} (свіжий аналіз)`;
  return `🗓 Відрізок ${shortDate(b.start)} ${range}`;
}

function findingText(f, idx) {
  const icon = f.type === 'error' ? ERROR_ICON : STRENGTH_ICON;
  const lines = [`${icon} ${idx}. ${f.claim}`, ''];
  lines.push(`Чому це впливає на записи: ${f.why}`);
  lines.push(`Що зробити: ${f.action}`);
  lines.push('');
  lines.push(`Докази (${f.evidence.length}):`);
  f.evidence.forEach((ev, i) => {
    lines.push(`${i + 1}. «${ev.quote}» — ${formatKyiv(new Date(ev.startTime))}`);
    if (ev.note) lines.push(`   ↳ ${ev.note}`);
  });
  return lines.join('\n');
}

async function sendBlockedCalls(api, chatId, report, { replyToMessageId } = {}) {
  if (!(report.stats?.blockedCount > 0)) return;
  const calls = await getBlockedCalls(report.name, report.start, report.end);
  if (!calls.length) return;

  const lines = [`🚧 Незакриті угоди — СТО не змогло взяти клієнта (${calls.length}):`, ''];
  calls.forEach((c, i) => {
    lines.push(`${i + 1}. ${BLOCKER_LABELS[c.blocker] || c.blocker} — ${formatKyiv(new Date(c.startTime))}`);
    lines.push(`   Клієнт: ${c.clientName || 'Невідомо'}${c.clientNumber ? ` · ${formatPhone(c.clientNumber)}` : ''}`);
    if (c.quote) lines.push(`   Менеджер: «${c.quote}»`);
    lines.push('');
  });
  lines.push('Це НЕ провтики менеджера — ці дзвінки не враховані в конверсії.');
  await sendLong(api, chatId, lines.join('\n'), { replyToMessageId });
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

async function sendReportSummary(api, chatId, report, { replyMarkup } = {}) {
  await sendLong(api, chatId, headerText(report), { parseMode: 'Markdown', replyMarkup });
}

async function sendReportFindings(api, chatId, report, { clips, missing, replyToMessageId } = {}) {
  try {
    await sendBlockedCalls(api, chatId, report, { replyToMessageId });
  } catch (err) {
    console.error(`[report] blocked-calls block failed: ${err.message}`);
  }

  const blocks = (report.blocks || []).filter((b) => (b.findings || []).length);
  if (!blocks.length) {
    const sales = report.stats.salesCount ?? 0;
    let msg;
    if (sales === 0) {
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
      if (clips && f.type === 'error') {
        for (const ev of f.evidence) {
          if (ev.start == null) continue;
          const buf = clips.get(clipKey(ev.callId, ev.start, ev.end));
          if (buf) await sendClip(api, chatId, buf, ev, { replyToMessageId });
        }
      }
    }
  }

  if (missing) {
    await sendLong(api, chatId, NOTICES.clipsUnavailable(missing), { replyToMessageId });
  }
}

const MODE_CODE = { daily: 'd', range: 'r', range_reuse: 'q', live: 'l' };
const MODE_BY_CODE = Object.fromEntries(Object.entries(MODE_CODE).map(([k, v]) => [v, k]));
const b36 = (date) => Math.floor(date.getTime() / 1000).toString(36);
const CALLBACK_LIMIT = 64;

function expandKeyOf(name, start, end, mode) {
  const key = `${MODE_CODE[mode] || 'd'}:${b36(start)}:${b36(end)}:${name}`;
  const longest = Buffer.byteLength(`report:exp:${key}`);
  if (longest > CALLBACK_LIMIT) {
    noteIssue('TG-CBDATA', {
      source: 'bot',
      feature: 'report',
      detail: `expandKey для «${name}» — ${longest} Б (ліміт ${CALLBACK_LIMIT})`,
      context: { manager: name, bytes: longest },
    }).catch(() => {});
  }
  return key;
}

async function deliverReport(api, chatId, report, { expandKey }) {
  const kb = new InlineKeyboard()
    .text('🔽 Розгорнути', `report:exp:${expandKey}`)
    .text('💬 Рекомендації', `report:phr:${expandKey}`);
  await sendReportSummary(api, chatId, report, { replyMarkup: kb });
}

async function deliverManagerReport(api, chatId, name, start, end, { mode = 'daily' } = {}) {
  const report = await buildReportByMode(mode, name, start, end);
  if (!report) return { empty: true };
  await deliverReport(api, chatId, report, { expandKey: expandKeyOf(name, start, end, mode) });
  return { sent: true };
}

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

function parseExpandKey(raw) {
  const m = /^([drql]):([0-9a-z]+):([0-9a-z]+):(.+)$/.exec(raw || '');
  if (!m) return null;
  return {
    mode: MODE_BY_CODE[m[1]],
    start: new Date(parseInt(m[2], 36) * 1000),
    end: new Date(parseInt(m[3], 36) * 1000),
    name: m[4],
  };
}

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
        const { clips, missing } = await prepareClips(report);
        await sendReportFindings(ctx.api, ctx.chat.id, report, { clips, missing, replyToMessageId });
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
      await ctx.reply(
        'Для цього періоду немає готових формулювань — замало дзвінків-угод із зафіксованою поведінкою (той самий поріг, що й для знахідок).',
        { reply_parameters: replyParameters }
      );
      return;
    }
    await sendPhrases(ctx.api, ctx.chat.id, report.phrases, { replyToMessageId });
  });
}

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
      if (!seg) continue;
      if (now.getTime() < seg.end.getTime() + graceMs) continue;
      const slotKey = `${dateStr}-${hhmm}`;
      if (delivered.includes(slotKey)) continue;

      console.log(`[bot] scheduled slot ${slotKey}: ${seg.start.toISOString()} -> ${seg.end.toISOString()}`);
      await sendScheduledSlot(api, seg.start, seg.end);
      await markSlotDelivered(slotKey);
    }
    await deleteOldManualTails(new Date(Date.now() - 2 * 24 * 3600 * 1000)).catch(() => {});
  } finally {
    running = false;
  }
}

function startScheduler(api) {
  console.log('[bot] report scheduler on (day-bounded segments, grace, times+recipients from /settings, Kyiv)');
  setInterval(() => {
    maybeSendScheduledReport(api).catch((e) => console.error(`[bot] scheduled report error: ${e.message}`));
  }, 30000);
}

export { buildManagerEvidenceReport, deliverManagerReport, sendManualReport, startScheduler, registerReportActions };
