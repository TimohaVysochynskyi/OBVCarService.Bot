import 'dotenv/config';
import { existsSync } from 'node:fs';
import {
  applyRoleFix,
  clearNonSalesScores,
  countNonSalesScores,
  getCallsForRoleAudit,
} from '../features/analysis/repo.js';
import { deleteReportSegmentsOverlapping } from '../features/reporting/repo.js';
import { measureRoleChannels } from '../platform/audio/channelEnergy.js';
import { storedAudioPath } from '../platform/audio/store.js';
import { migrate } from '../platform/db/pool.js';
import { displayName } from '../features/operators/display.js';
import {
  ROLE_INVERTED,
  ROLE_OK,
  ROLE_UNCLEAR,
  channelRatios,
  channelVerdict,
  invertRoles,
  transcriptFromSegments,
} from '../domain/call/roles.js';
import { config } from '../shared/config.js';


const DEFAULT_MARGIN = 1.35;
const DEFAULT_SAMPLE = 10;
const PROGRESS_EVERY = 100;

function flagValue(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : null;
}

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = flagValue('--limit') ? Number(flagValue('--limit')) : null;
const SINCE = flagValue('--since');
const MARGIN = flagValue('--margin') ? Number(flagValue('--margin')) : DEFAULT_MARGIN;
const SAMPLE = flagValue('--sample') ? Number(flagValue('--sample')) : DEFAULT_SAMPLE;

const monthOf = (startTime) => new Date(startTime).toISOString().slice(0, 7);

function pct(part, total) {
  return total ? `${((part / total) * 100).toFixed(1)}%` : '—';
}

function bump(bucket, key, verdict) {
  bucket[key] ??= { [ROLE_OK]: 0, [ROLE_INVERTED]: 0, [ROLE_UNCLEAR]: 0 };
  bucket[key][verdict] += 1;
}

function printBreakdown(title, bucket, label = (k) => k) {
  console.log(`\n[fixRoles] ${title}:`);
  for (const key of Object.keys(bucket).sort()) {
    const row = bucket[key];
    const decided = row[ROLE_OK] + row[ROLE_INVERTED];
    console.log(
      `  ${label(key).padEnd(14)} коректно ${String(row[ROLE_OK]).padStart(5)}` +
        ` · перевернуто ${String(row[ROLE_INVERTED]).padStart(5)} (${pct(row[ROLE_INVERTED], decided)})` +
        ` · неоднозначно ${String(row[ROLE_UNCLEAR]).padStart(5)}`
    );
  }
}

function spread(rows, howMany) {
  if (rows.length <= howMany) return rows;
  const step = rows.length / howMany;
  return Array.from({ length: howMany }, (unused, i) => rows[Math.floor(i * step)]);
}

function printSamples(samples) {
  if (!SAMPLE) return;
  console.log(`\n[fixRoles] вибірка для ручної звірки (до ${SAMPLE} на вердикт, рівномірно по всьому періоду):`);
  for (const verdict of [ROLE_OK, ROLE_INVERTED, ROLE_UNCLEAR]) {
    const rows = spread(samples[verdict], SAMPLE);
    if (!rows.length) continue;
    console.log(`  ${verdict}:`);
    for (const row of rows) {
      console.log(
        `    ${row.id} · ${String(row.at).slice(0, 16)} · ${row.direction || '—'}` +
          ` · ${displayName(row.manager) ?? row.manager} · менеджер ${row.ratio.manager}× на своєму каналі,` +
          ` клієнт ${row.ratio.client}×`
      );
    }
  }
}

async function purgeReportCache(touched) {
  if (!touched.size) return;
  console.log(`\n[fixRoles] чистка кешу висновків для ${touched.size} менеджер(ів):`);
  for (const [manager, span] of touched) {
    const removed = await deleteReportSegmentsOverlapping(manager, span.from, span.to);
    console.log(`  ${displayName(manager) ?? manager}: видалено ${removed} відрізк(ів)`);
  }
}

async function clearStaleScores() {
  const stale = await countNonSalesScores();
  if (!stale) return;
  if (DRY_RUN) {
    console.log(`[fixRoles] непродажних дзвінків зі сміттєвою оцінкою: ${stale} (DRY-RUN, не чіпаю)`);
    return;
  }
  const cleared = await clearNonSalesScores();
  console.log(`[fixRoles] обнулено успіх/бал/етап у ${cleared} непродажних дзвінк(ах) — їх оцінили до перекласифікації`);
}

async function main() {
  await migrate();
  await clearStaleScores();

  const calls = await getCallsForRoleAudit({
    limit: LIMIT,
    since: SINCE ? new Date(SINCE) : null,
  });
  console.log(
    `[fixRoles] дзвінків із записом і таймкодами: ${calls.length}` +
      ` · канал менеджера ${config.call.managerChannel} · запас ${MARGIN}×` +
      `${DRY_RUN ? ' · DRY-RUN, нічого не пишеться' : ''}` +
      ' (без жодного звернення до OpenAI/ElevenLabs/Binotel)'
  );

  const totals = { [ROLE_OK]: 0, [ROLE_INVERTED]: 0, [ROLE_UNCLEAR]: 0 };
  const samples = { [ROLE_OK]: [], [ROLE_INVERTED]: [], [ROLE_UNCLEAR]: [] };
  const byMonth = {};
  const byDirection = {};
  const byManager = {};
  const touched = new Map();
  let mono = 0;
  let noFile = 0;
  let failed = 0;

  for (const [i, call] of calls.entries()) {
    const path = storedAudioPath(call.audioPath);
    if (!existsSync(path)) {
      noFile += 1;
      continue;
    }

    let measured;
    try {
      measured = await measureRoleChannels(path, call.segments);
    } catch (err) {
      failed += 1;
      console.error(`[fixRoles] ${call.generalCallId}: замір не вдався — ${err.message.slice(0, 160)}`);
      continue;
    }

    if (measured.mono) {
      mono += 1;
      continue;
    }

    const verdict = channelVerdict(measured, {
      managerChannel: config.call.managerChannel,
      margin: MARGIN,
    });
    totals[verdict] += 1;
    bump(byMonth, monthOf(call.startTime), verdict);
    bump(byDirection, call.direction || 'невідомо', verdict);
    bump(byManager, call.managerName || '—', verdict);
    const ratio = channelRatios(measured, config.call.managerChannel);
    samples[verdict].push({
      id: call.generalCallId,
      at: call.startTime.toISOString(),
      direction: call.direction,
      manager: call.managerName || '—',
      ratio: { manager: (ratio?.manager ?? 0).toFixed(2), client: (ratio?.client ?? 0).toFixed(2) },
    });

    if (verdict === ROLE_INVERTED) {
      const segments = invertRoles(call.segments);
      if (!DRY_RUN) {
        await applyRoleFix(call.generalCallId, {
          transcript: transcriptFromSegments(segments),
          segments,
        });
      }
      const manager = call.managerName || '—';
      const at = new Date(call.startTime);
      const span = touched.get(manager);
      if (!span) touched.set(manager, { from: at, to: at });
      else {
        if (at < span.from) span.from = at;
        if (at > span.to) span.to = at;
      }
    }

    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.log(`[fixRoles] … ${i + 1}/${calls.length}, перевернутих поки ${totals[ROLE_INVERTED]}`);
    }
  }

  const decided = totals[ROLE_OK] + totals[ROLE_INVERTED];
  console.log('\n[fixRoles] --- РЕЗУЛЬТАТ ---');
  console.log(`  коректно:            ${totals[ROLE_OK]}`);
  console.log(`  перевернуто:         ${totals[ROLE_INVERTED]} (${pct(totals[ROLE_INVERTED], decided)} визначених)`);
  console.log(`  неоднозначно:        ${totals[ROLE_UNCLEAR]} (не чіпали)`);
  console.log(`  моно, замір неможливий: ${mono}`);
  console.log(`  запису немає на диску:  ${noFile}`);
  console.log(`  замір не вдався:        ${failed}`);

  printBreakdown('по місяцях', byMonth);
  printBreakdown('за напрямком', byDirection);
  printBreakdown('по менеджерах', byManager, (name) => displayName(name) ?? name);
  printSamples(samples);

  if (DRY_RUN) {
    console.log('\n[fixRoles] DRY-RUN: жоден рядок не змінено, кеш висновків не чищено.');
    return;
  }

  await purgeReportCache(touched);
  console.log(
    '\n[fixRoles] виправленим дзвінкам обнулено розбір (мета, успіх, бал, етап, блокер, причина відмови,' +
      ' представлення) — беклоги підхоплять їх своїм звичайним IS NULL.'
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[fixRoles] впав:', err);
    process.exit(1);
  });
