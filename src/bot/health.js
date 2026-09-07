import { InlineKeyboard } from 'grammy';
import { spawn } from 'node:child_process';
import {
  pingDb,
  getHeartbeat,
  getCheckpoint,
  listKbDocs,
  summarizeErrorLog,
  getAudioArchiveStats,
} from '../core/store.js';
import { listCallsForPeriod } from '../core/binotel.js';
import { getElevenLabsBalance } from '../core/elevenlabs.js';
import { freeSpaceMb } from '../core/audioStore.js';
import { fetchOk } from '../core/http.js';
import { classify } from '../core/errors.js';
import { HEALTH } from '../core/errorTexts.js';
import { ffmpegAvailable } from './audioClip.js';
import { showScreen } from './ui.js';
import { formatKyiv } from './time.js';

// Екран «🩺 Перевірка» (`/health`, admin) — стан кожної залежності на вимогу.
//
// Журнал (`/log`) показує, що вже зламалось; цей екран відповідає на інше питання: «що саме
// лежить ЗАРАЗ». Без нього дізнатися це можна було лише наткнувшись на помилку в конкретній дії —
// а коли не працює одразу кілька речей, по одній помилці не зрозуміти, скільки їх.
//
// Правила, яких тут треба триматись:
//   • жодна перевірка не має права ні кинути, ні висіти — інакше екран не намалюється взагалі;
//   • усі йдуть паралельно, бо послідовно це були б десятки секунд;
//   • перевірки безкоштовні: список моделей OpenAI, а не запит до моделі; вікно в одну хвилину
//     в Binotel; читання балансу ElevenLabs. Натискання цієї кнопки не має нічого коштувати.
//
// Тексти — у core/errorTexts.js (розділ HEALTH).

const PROBE_TIMEOUT_MS = 8000;

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';
const ICON = { ok: '✅', warn: '⚠️', fail: '❌' };

// Обгортка: будь-яке падіння перевірки перетворюється на її ж червоний рядок із класом помилки,
// а не валить увесь екран.
async function probe(label, fn) {
  try {
    const { status, detail } = await fn();
    return { label, status, detail };
  } catch (err) {
    return { label, status: FAIL, detail: HEALTH.byCode(classify(err)) };
  }
}

function ageMinutes(at) {
  return at ? Math.round((Date.now() - new Date(at).getTime()) / 60000) : null;
}

// ffprobe немає окремої перевірки в проєкті (він потрібен лише для визначення стерео/моно), тож
// найпростіше — спитати його версію. Мовчазна деградація без ffprobe тиха: стерео-дзвінки
// вважаються моно, і якість розділення реплік падає без жодного сигналу.
function ffprobeAvailable() {
  return new Promise((resolve) => {
    try {
      const p = spawn(process.env.FFPROBE_PATH || 'ffprobe', ['-version']);
      const timer = setTimeout(() => {
        p.kill('SIGKILL');
        resolve(false);
      }, 5000);
      p.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      p.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

async function checkDatabase() {
  await pingDb();
  return { status: OK, detail: HEALTH.dbOk };
}

async function checkBinotel() {
  const now = new Date();
  await listCallsForPeriod(new Date(now.getTime() - 60_000), now);
  return { status: OK, detail: HEALTH.binotelOk };
}

async function checkOpenAi() {
  if (!process.env.OPENAI_API_KEY) return { status: FAIL, detail: HEALTH.noKey };
  const model = process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';
  // Список моделей нічого не коштує й нічого не витрачає — перевіряє саме доступність і ключ.
  await fetchOk(
    'openai',
    'перевірка ключа',
    `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } },
    { timeoutMs: PROBE_TIMEOUT_MS }
  );
  // ⚠️ Ключ приймається ≠ на рахунку є кошти: залишок цей ендпоінт не показує, і саме тому
  // OAI-QUOTA виявляється лише на справжньому запиті.
  return { status: OK, detail: HEALTH.openAiOk };
}

async function checkElevenLabs() {
  if (!process.env.ELEVENLABS_API_KEY) return { status: WARN, detail: HEALTH.byCode('ELV-NOKEY') };
  const balance = await getElevenLabsBalance();
  if (!balance.ok) {
    if (balance.reason === 'missing_permission') return { status: WARN, detail: HEALTH.byCode('ELV-PERM') };
    if (balance.reason === 'unauthorized') return { status: FAIL, detail: HEALTH.byCode('ELV-AUTH') };
    return { status: WARN, detail: HEALTH.elevenUnknown };
  }
  const usdPer1000 = Number(process.env.ELEVENLABS_USD_PER_1000_CREDITS || 0.22);
  const minUsd = Number(process.env.ELEVENLABS_MIN_BALANCE_USD || 2);
  const usd = (balance.remainingCredits / 1000) * usdPer1000;
  return {
    status: usd < minUsd ? WARN : OK,
    detail: HEALTH.elevenBalance(usd.toFixed(2), balance.remainingCredits),
  };
}

async function checkAudioTools() {
  const [ffmpeg, ffprobe] = await Promise.all([ffmpegAvailable(), ffprobeAvailable()]);
  if (!ffmpeg) return { status: FAIL, detail: HEALTH.byCode('FFM-MISSING') };
  if (!ffprobe) return { status: WARN, detail: HEALTH.byCode('FFP-MISSING') };
  return { status: OK, detail: HEALTH.audioToolsOk };
}

async function checkDisk() {
  const freeMb = await freeSpaceMb();
  if (freeMb == null) return { status: WARN, detail: HEALTH.diskUnknown };
  const minFreeMb = Number(process.env.AUDIO_MIN_FREE_MB || 1024);
  const stats = await getAudioArchiveStats().catch(() => null);
  const archiveMb = stats ? Math.round(Number(stats.bytes) / (1024 * 1024)) : null;
  return {
    status: freeMb < minFreeMb ? WARN : OK,
    detail: HEALTH.disk(freeMb, archiveMb),
  };
}

// Не «чи бігає процес прямо в цю мілісекунду», а чи він бігав недавно: cron полера — */15.
async function checkIngest() {
  const [beat, checkpoint] = await Promise.all([getHeartbeat('poll'), getCheckpoint()]);
  const beatAge = ageMinutes(beat);
  if (beatAge == null) return { status: WARN, detail: HEALTH.ingestUnknown };
  const maxMin = Number(process.env.POLL_STALE_MAX_MIN || 45);
  // Чекпоінт може відставати від прогону законно (аварія Binotel), тож він тут довідково —
  // сам факт «процес бігає» визначає саме відмітка.
  return {
    status: beatAge > maxMin ? FAIL : OK,
    detail: HEALTH.ingest(beatAge, ageMinutes(checkpoint)),
  };
}

async function checkKnowledgeBase(kbState) {
  if (!kbState?.ready) return { status: WARN, detail: HEALTH.byCode('DB-NOVECTOR') };
  const docs = await listKbDocs();
  const chunks = docs.reduce((n, d) => n + (d.chunkCount || 0), 0);
  return {
    status: docs.length ? OK : WARN,
    detail: docs.length ? HEALTH.kb(docs.length, chunks) : HEALTH.kbEmpty,
  };
}

async function healthReport(kbState) {
  const rows = await Promise.all([
    probe(HEALTH.labels.db, checkDatabase),
    probe(HEALTH.labels.binotel, checkBinotel),
    probe(HEALTH.labels.openai, checkOpenAi),
    probe(HEALTH.labels.elevenlabs, checkElevenLabs),
    probe(HEALTH.labels.audio, checkAudioTools),
    probe(HEALTH.labels.disk, checkDisk),
    probe(HEALTH.labels.ingest, checkIngest),
    probe(HEALTH.labels.kb, () => checkKnowledgeBase(kbState)),
  ]);

  const incidents = await summarizeErrorLog(new Date(Date.now() - 24 * 3600 * 1000))
    .then((sum) => sum.reduce((n, r) => n + r.count, 0))
    .catch(() => null);

  const width = Math.max(...rows.map((r) => r.label.length));
  const lines = [HEALTH.title, formatKyiv(new Date()), ''];
  for (const r of rows) lines.push(`${ICON[r.status]} ${r.label.padEnd(width)}  ${r.detail}`);

  const bad = rows.filter((r) => r.status === FAIL).length;
  const warn = rows.filter((r) => r.status === WARN).length;
  lines.push('', HEALTH.verdict(bad, warn));
  if (incidents != null) lines.push(HEALTH.incidents(incidents));
  return lines.join('\n');
}

// Перевірки ходять у мережу, тож екран не з'явиться миттєво — краще одразу сказати про це, ніж
// лишити людину дивитись на нерухоме меню.
async function openHealth(ctx, kbState) {
  const kb = new InlineKeyboard()
    .text(HEALTH.refresh, 'health:r')
    .row()
    .text('« Назад до меню', 'menu');
  await showScreen(ctx, HEALTH.checking, new InlineKeyboard(), { parseMode: null });
  const text = await healthReport(kbState);
  await showScreen(ctx, text, kb, { parseMode: null });
}

function registerHealth(bot, kbState) {
  bot.callbackQuery(/^health(:r)?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await openHealth(ctx, kbState);
  });
}

export { registerHealth, openHealth, healthReport };
