import 'dotenv/config';
import { migrate } from '../core/store.js';
import { buildGlobalReport } from '../bot/globalReportData.js';
import { buildSite, zipSite } from '../bot/globalReportBundle.js';


function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || true;
}

async function main() {
  const analyze = !process.argv.includes('--no-analyze');
  const zipTo = arg('--zip');

  await migrate();
  const started = Date.now();

  const report = await buildGlobalReport({ analyze, budgetMs: 0 });
  const built = await buildSite(report);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const c = built.clips;
  console.log(`\n[buildReportSite] ${built.dir}`);
  console.log(`  період:      ${report.period.start.slice(0, 10)} — ${report.period.end.slice(0, 10)}`);
  console.log(`  дзвінків:    ${report.totals.calls}, менеджерів: ${report.managers.length}`);
  console.log(`  фрагментів:  вирізано ${c.cut}, узято готовими ${c.reused}, без таймкоду ${c.noTimecode}, без запису ${c.noRecording}, не вдалось ${c.failed}`);
  console.log(`  аудіо:       ${built.audio.files} файлів, ${(built.audio.bytes / 1048576).toFixed(1)} МБ`);
  console.log(`  зібрано за:  ${seconds}с`);

  const incomplete = report.managers.filter((m) => m.partial).map((m) => m.display);
  if (incomplete.length) {
    console.log(`  ⚠️ неповне покриття аналізу: ${incomplete.join(', ')} — повтори прогін, він продовжить звідти, де кеш уже є`);
    process.exitCode = 1;
  }
  if (c.failed) {
    console.log('  ⚠️ частина фрагментів не вирізалась — у звіті там лишився лише текст цитати');
    process.exitCode = 1;
  }

  if (zipTo) {
    await zipSite(built.dir, typeof zipTo === 'string' ? zipTo : 'report-site.zip');
    console.log(`  архів:       ${zipTo}`);
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('[buildReportSite] впав:', err);
    process.exit(1);
  });
