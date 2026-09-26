import 'dotenv/config';
import { migrate, getRecentCallsForIntro, updateCallIntro } from '../core/store.js';
import { analyzeCallBehaviors } from '../core/analyzeCall.js';
import { PERSONAL_OPERATORS } from '../core/phoneLines.js';


const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

const LIMIT = arg('--limit', 100);
const PAUSE_MS = Number(process.env.RESCORE_INTRO_PAUSE_MS || 500);
const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : '—');
const yn = (v) => (v === true ? 'так' : v === false ? 'ні' : '—');

async function main() {
  await migrate();

  const calls = await getRecentCallsForIntro(LIMIT);
  console.log(`[rescoreIntro] останніх дзвінків до перевірки моделлю: ${calls.length}`);

  const changed = [];
  let failed = 0;
  const byManager = new Map();
  const dir = { in: { n: 0, name: 0 }, out: { n: 0, name: 0 } };

  for (const [i, call] of calls.entries()) {
    const managerName = PERSONAL_OPERATORS[String(call.internalNumber)] || call.managerName;
    let intro;
    try {
      const res = await analyzeCallBehaviors(call.transcript, call.segments, managerName);
      intro = res.intro;
    } catch (err) {
      failed += 1;
      console.error(`[rescoreIntro] ${call.generalCallId}: ${err.message}`);
      continue;
    }

    if (intro.name !== call.introName || intro.company !== call.introCompany) {
      changed.push({ ...call, was: { name: call.introName, company: call.introCompany }, now: intro });
    }
    await updateCallIntro(call.generalCallId, intro);

    const acc = byManager.get(managerName) || { n: 0, name: 0, company: 0 };
    acc.n += 1;
    if (intro.name) acc.name += 1;
    if (intro.company) acc.company += 1;
    byManager.set(managerName, acc);

    if (dir[call.direction]) {
      dir[call.direction].n += 1;
      if (intro.name) dir[call.direction].name += 1;
    }

    if ((i + 1) % 25 === 0) console.log(`[rescoreIntro] … ${i + 1}/${calls.length}`);
    if (PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  const done = calls.length - failed;
  const withName = [...byManager.values()].reduce((n, a) => n + a.name, 0);
  const withCompany = [...byManager.values()].reduce((n, a) => n + a.company, 0);
  const first = calls.at(-1)?.startTime;
  const last = calls[0]?.startTime;
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

  console.log('\n[rescoreIntro] --- РЕЗУЛЬТАТ ---');
  console.log(`  період:            ${day(first)} — ${day(last)}`);
  console.log(`  перевірено:        ${done}${failed ? ` (не вдалось: ${failed})` : ''}`);
  console.log(`  назвав своє імʼя:  ${withName} (${pct(withName, done)})`);
  console.log(`  назвав сервіс:     ${withCompany} (${pct(withCompany, done)})`);
  console.log(`  жодного з двох:    ${done - withName - withCompany + [...byManager.values()].reduce((n, a) => n + Math.min(a.name, a.company), 0)}`);

  console.log('\n  за напрямком (імʼя):');
  console.log(`    вхідні:   ${dir.in.name} з ${dir.in.n} (${pct(dir.in.name, dir.in.n)})`);
  console.log(`    вихідні:  ${dir.out.name} з ${dir.out.n} (${pct(dir.out.name, dir.out.n)})`);

  console.log('\n  за менеджерами:');
  for (const [name, a] of [...byManager].sort((x, y) => y[1].n - x[1].n)) {
    console.log(
      `    ${name.padEnd(12)} дзвінків ${String(a.n).padStart(3)}` +
        ` · імʼя ${String(a.name).padStart(3)} (${pct(a.name, a.n).padStart(4)})` +
        ` · сервіс ${String(a.company).padStart(3)} (${pct(a.company, a.n).padStart(4)})`
    );
  }

  console.log(`\n  розійшлось із попередньою (правиловою) оцінкою: ${changed.length} з ${done}`);
  for (const c of changed.slice(0, 12)) {
    const line = (c.segments || []).find((s) => s?.role === 'manager')?.text || '';
    console.log(
      `    ${new Date(c.startTime).toISOString().slice(5, 16).replace('T', ' ')} ${String(c.managerName).padEnd(10)}` +
        ` імʼя ${yn(c.was.name)}→${yn(c.now.name)} · сервіс ${yn(c.was.company)}→${yn(c.now.company)}` +
        `  «${line.slice(0, 60)}»`
    );
  }
  if (changed.length > 12) console.log(`    … і ще ${changed.length - 12}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[rescoreIntro] впав:', err);
    process.exit(1);
  });
