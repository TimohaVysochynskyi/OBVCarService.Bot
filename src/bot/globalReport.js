import { InputFile } from 'grammy';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGlobalReport, ALL } from './globalReportData.js';
import { buildSite, zipSite } from './globalReportBundle.js';
import { withProgress } from './ui.js';

const NOTICE = '⏳ Звіт за весь період готується. Перший раз це займає кілька хвилин.';

function periodLabel(report) {
  const from = report.period.start.slice(0, 10).split('-').reverse().join('.');
  const to = report.period.end.slice(0, 10).split('-').reverse().join('.');
  return `${from} - ${to}`;
}

function caption(report, built) {
  const t = report.totals;
  const lines = [
    '📊 Звіт за весь період',
    `${t.calls} дзвінків · ${t.hours} год розмов · ${t.managers} менеджери`,
    '',
    `Угоди ${t.purposes.sales} · інформаційні ${t.purposes.info} · службові ${t.purposes.other} · особисті ${t.purposes.personal}`,
    `Відмов СТО: ${report.declines.serviceTotal}`,
  ];

  if (built.audio.files) {
    lines.push(`Аудіо-фрагментів під прикладами: ${built.audio.files}`);
  } else if (built.clips.wanted) {
    lines.push('Аудіо-фрагменти цього разу не вирізались — у звіті лишився тільки текст цитат.');
  }

  lines.push('', 'Розпакуйте архів і відкрийте index.html — усе всередині, інтернет не потрібен.');
  return lines.join('\n');
}

async function sendGlobalReport(ctx) {
  const chatId = ctx.chat.id;

  const report = await withProgress(ctx.api, chatId, 'upload_document', () => buildGlobalReport({ analyze: true }), {
    notice: NOTICE,
  });

  const built = await buildSite(report);

  const dir = await mkdtemp(join(tmpdir(), 'obv-global-'));
  const zipPath = join(dir, 'report.zip');
  try {
    await zipSite(built.dir, zipPath);
    await ctx.api.sendDocument(chatId, new InputFile(zipPath, `Звіт по дзвінках ${periodLabel(report)}.zip`), {
      caption: caption(report, built),
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function registerGlobalReport(bot) {
  bot.command('globalreport', sendGlobalReport);
}

export { registerGlobalReport, sendGlobalReport, ALL };
