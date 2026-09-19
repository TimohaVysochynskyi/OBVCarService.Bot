import 'dotenv/config';
import { migrate } from '../core/store.js';
import { buildGlobalReport, ALL } from '../bot/globalReportData.js';

async function main() {
  const analyze = !process.argv.includes('--no-analyze');
  await migrate();

  const started = Date.now();
  const report = await buildGlobalReport({ analyze });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const t = report.totals;
  console.log(`\nПеріод: ${report.period.start.slice(0, 10)} — ${report.period.end.slice(0, 10)}`);
  console.log(`Дзвінків: ${t.calls}, годин: ${t.hours}, менеджерів: ${t.managers}`);
  console.log(`Угоди ${t.purposes.sales} · інформаційні ${t.purposes.info} · службові ${t.purposes.other} · особисті ${t.purposes.personal}`);
  console.log(`Місяці: ${report.months.map((m) => m.title).join(', ')}`);

  for (const m of report.managers) {
    const all = m.byMonth[ALL] || {};
    console.log(
      `\n${m.display}: дзвінків ${all.calls}, угод ${all.sales}, записів ${all.success}, ` +
        `конверсія ${all.conversion ?? '—'}%, бал ${all.avgScore ?? '—'}`
    );
    console.log(`  плюси: ${m.strengths.length}, мінуси: ${m.weaknesses.length} (днів проаналізовано ${m.analysedDays}/${m.days})`);
    for (const f of m.strengths) console.log(`   + ${f.claim} (${f.examples.length} прикл.)`);
    for (const f of m.weaknesses) console.log(`   − ${f.claim} (${f.examples.length} прикл.)`);
  }

  const d = report.declines;
  console.log(`\nВідмови СТО: ${d.serviceTotal}`);
  for (const [bucket, n] of Object.entries(d.buckets)) console.log(`  ${d.bucketLabels[bucket]}: ${n}`);
  console.log('Причини:');
  for (const r of d.reasons) console.log(`  ${String(r.count).padStart(4)}  ${r.side === 'service' ? 'СТО   ' : 'клієнт'} ${r.label}`);
  console.log(`Покриття: незакритих угод ${d.coverage.notBooked}, з них відмова СТО ${d.coverage.notBookedBlocked}, причину клієнта визначено ${d.coverage.clientExplained}, ще не перевірено ${d.coverage.unchecked}`);

  console.log('\nСлабкі етапи:');
  for (const s of report.stages) console.log(`  ${String(s.count).padStart(4)}  ${s.stage}`);

  console.log(`\nЗібрано за ${seconds}с`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[warmGlobalReport] впав:', err);
    process.exit(1);
  });
