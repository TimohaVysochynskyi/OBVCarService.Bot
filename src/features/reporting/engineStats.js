import {
  getEngineBreakdown,
  getEngineCars,
  getEngineCoverage,
  getEngineMonthlyTotals,
} from './repo.js';
import { isRepairService, serviceLabel } from '../../domain/call/engine.js';
import { monthTitle } from './globalReportData.js';

const TOP_CARS = 8;

const share = (part, total) => (total ? `${((part / total) * 100).toFixed(1)}%` : '—');

function shortMonth(key) {
  const [year, month] = String(key).split('-');
  return `${monthTitle(`${year}-${month}`).split(' ')[0].slice(0, 3)}'${year.slice(2)}`;
}

function monthLines(rows) {
  return rows
    .filter((r) => r.total)
    .map(
      (r) =>
        `${shortMonth(r.month).padEnd(7)}${String(r.engine).padStart(4)}` +
        `${share(r.engine, r.total).padStart(8)}` +
        `${String(r.engineBooked).padStart(7)}`
    )
    .join('\n');
}

async function engineStatsText() {
  const [monthly, breakdown, cars, coverage] = await Promise.all([
    getEngineMonthlyTotals(),
    getEngineBreakdown(),
    getEngineCars(),
    getEngineCoverage(),
  ]);

  const total = monthly.reduce((n, r) => n + r.engine, 0);
  if (!total) {
    const checked = coverage?.checked ?? 0;
    return (
      '🔧 *Звернення по двигуну*\n\nЖодного звернення поки не знайдено.\n\n' +
      `Перевірено ${checked} з ${coverage?.total ?? 0} розмов. ` +
      'Якщо перевірено ще не всі — беклог `backfill:engine` їх добере.'
    );
  }

  const services = new Map();
  for (const row of breakdown) services.set(row.service, (services.get(row.service) || 0) + row.count);
  const repair = [...services.entries()].filter(([k]) => isRepairService(k)).reduce((n, [, c]) => n + c, 0);

  const serviceLines = [...services.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${(serviceLabel(key) || key).padEnd(26)}${String(count).padStart(4)}`)
    .join('\n');

  const carLines = cars
    .slice(0, TOP_CARS)
    .map((c) => `${c.car.slice(0, 26).padEnd(26)}${String(c.count).padStart(4)}`)
    .join('\n');

  const lines = [
    '🔧 *Звернення по двигуну*',
    '',
    `Усього: *${total}*, із них ремонтні роботи: *${repair}*.`,
    `Перевірено ${coverage.checked} з ${coverage.total} розмов.`,
    '',
    '*Динаміка по місяцях*',
    '```',
    `${'Місяць'.padEnd(7)}${'Звн'.padStart(4)}${'Частка'.padStart(8)}${'Запис'.padStart(7)}`,
    monthLines(monthly),
    '```',
    '*Яка робота потрібна*',
    '```',
    serviceLines,
    '```',
  ];

  if (carLines) {
    lines.push('*Які авто*', '```', carLines, '```');
  }

  lines.push('_«Звн» — звернень по двигуну, «Частка» — скільки це від усіх розмов місяця, «Запис» — скільки з них записались._');
  return lines.join('\n');
}

export { engineStatsText };
