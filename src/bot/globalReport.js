import { InputFile } from 'grammy';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGlobalReport, ALL } from './globalReportData.js';
import { renderGlobalReport } from './globalReportHtml.js';
import { withProgress } from './ui.js';

const NOTICE = '⏳ Звіт за весь період готується. Перший раз це займає кілька хвилин.';

function fileName(report) {
  const from = report.period.start.slice(0, 10).split('-').reverse().join('.');
  const to = report.period.end.slice(0, 10).split('-').reverse().join('.');
  return `Звіт по дзвінках ${from} - ${to}.html`;
}

function caption(report) {
  const t = report.totals;
  const lines = [
    `📊 Звіт за весь період`,
    `${t.calls} дзвінків · ${t.hours} год розмов · ${t.managers} менеджери`,
    '',
    `Угоди ${t.purposes.sales} · інформаційні ${t.purposes.info} · службові ${t.purposes.other} · особисті ${t.purposes.personal}`,
    `Відмов СТО: ${report.declines.serviceTotal}`,
    '',
    'Файл відкривається у браузері, працює без інтернету.',
  ];
  return lines.join('\n');
}

async function sendGlobalReport(ctx) {
  const chatId = ctx.chat.id;

  const report = await withProgress(ctx.api, chatId, 'upload_document', () => buildGlobalReport({ analyze: true }), {
    notice: NOTICE,
  });

  const html = renderGlobalReport(report);
  const dir = await mkdtemp(join(tmpdir(), 'obv-global-'));
  const path = join(dir, 'report.html');

  try {
    await writeFile(path, html, 'utf8');
    await ctx.api.sendDocument(chatId, new InputFile(path, fileName(report)), { caption: caption(report) });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function registerGlobalReport(bot) {
  bot.command('global-report', sendGlobalReport);
}

export { registerGlobalReport, sendGlobalReport, ALL };
