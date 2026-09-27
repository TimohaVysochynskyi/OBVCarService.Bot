import { test } from 'node:test';
import assert from 'node:assert/strict';

const NAMES = [
  'DATABASE_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOOTSTRAP_CHAT_IDS', 'ALERT_FALLBACK_CHAT_IDS',
  'BINOTEL_API_KEY', 'BINOTEL_API_SECRET', 'BINOTEL_BASE_URL', 'OPENAI_API_KEY',
  'OPENAI_ANALYZE_MODEL', 'OPENAI_REPORT_MODEL', 'ELEVENLABS_API_KEY', 'ELEVENLABS_MIN_BALANCE_USD',
  'CALL_LANGUAGE', 'LONG_PAUSE_SEC', 'SHARED_EXTENSIONS', 'EXCLUDED_EXTENSIONS', 'PERSONAL_OPERATORS',
  'POLL_OVERLAP_MIN', 'POLL_CHUNK_PAUSE_MS', 'MAX_PENDING_ATTEMPTS', 'AUDIO_CLIP_PAD_SEC',
  'SEGMENT_CONSISTENCY_PASSES', 'GLOBAL_REPORT_CONCURRENCY', 'GLOBAL_REPORT_PAUSE_MS',
  'GLOBAL_REPORT_BUDGET_MS', 'HTTP_TIMEOUT_MS', 'KB_CLIP_PAD_PAGES', 'FFMPEG_PATH',
];

let caseNumber = 0;

async function withEnv(env) {
  const saved = {};
  for (const name of NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  caseNumber += 1;
  const module = await import(`../../src/shared/config.js?case=${caseNumber}`);
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  return module;
}

const defaults = await withEnv({});

test('конфіг заморожений — жоден модуль не перепише значення на льоту', () => {
  assert.ok(Object.isFrozen(defaults.config));
  assert.ok(Object.isFrozen(defaults.config.poll));
  assert.throws(() => { defaults.config.poll.chunkPauseMs = 99; }, TypeError);
});

test('дефолти збережені такими, якими були розсипані по модулях', () => {
  const c = defaults.config;
  assert.equal(c.poll.overlapMin, 15);
  assert.equal(c.poll.chunkPauseMs, 1500);
  assert.equal(c.poll.windowMinutes, 20);
  assert.equal(c.poll.maxPendingAttempts, 20);
  assert.equal(c.poll.errorLogKeepDays, 30);
  assert.equal(c.poll.jobType, 'poll');
});

test('дефолти моделей ті самі, що були в кожному модулі окремо', () => {
  const c = defaults.config;
  assert.equal(c.openai.analyzeModel, 'gpt-4o-mini');
  assert.equal(c.openai.reportModel, 'gpt-4o');
  assert.equal(c.openai.blockerModel, 'gpt-4o');
  assert.equal(c.openai.embedModel, 'text-embedding-3-small');
  assert.equal(c.elevenlabs.sttModel, 'scribe_v1');
  assert.equal(c.elevenlabs.numSpeakers, '2');
});

test('курс і поріг ElevenLabs лишились прибиті одне до одного', () => {
  assert.equal(defaults.config.elevenlabs.usdPer1000Credits, 0.3642);
  assert.equal(defaults.config.elevenlabs.minBalanceUsd, 3.31);
});

test('решта дефолтів збережена', () => {
  const c = defaults.config;
  assert.equal(c.binotel.baseUrl, 'https://api.binotel.com/api/4.0');
  assert.equal(c.binotel.outageReminderMin, 120);
  assert.equal(c.call.longPauseSec, 4);
  assert.equal(c.audio.clipPadSec, 3);
  assert.equal(c.audio.minFreeMb, 1024);
  assert.equal(c.audio.ffmpegPath, 'ffmpeg');
  assert.equal(c.audio.ffprobePath, 'ffprobe');
  assert.equal(c.audio.ffmpegTimeoutMs, 60000);
  assert.equal(c.report.segmentPasses, 3);
  assert.equal(c.report.segmentGraceMin, 10);
  assert.equal(c.report.concurrency, 1);
  assert.equal(c.report.pauseMs, 1500);
  assert.equal(c.report.budgetMs, 120000);
  assert.equal(c.report.kbClipPadPages, 1);
  assert.equal(c.liveness.botMaxMin, 10);
  assert.equal(c.liveness.pollMaxMin, 45);
  assert.equal(c.backfill.blockerPauseMs, 0);
  assert.equal(c.backfill.audioPauseMs, 1500);
});

test('перекриття чекпоінта: env переважує', async () => {
  const { config } = await withEnv({ POLL_OVERLAP_MIN: '5' });
  assert.equal(config.poll.overlapMin, 5);
});

test('перекриття чекпоінта: 0 = вимкнути (стара, дірява поведінка)', async () => {
  const { config } = await withEnv({ POLL_OVERLAP_MIN: '0' });
  assert.equal(config.poll.overlapMin, 0);
});

test('перекриття чекпоінта: сміття → дефолт, а не NaN', async () => {
  const { config, configIssues } = await withEnv({ POLL_OVERLAP_MIN: 'дурня' });
  assert.equal(config.poll.overlapMin, 15);
  assert.ok(configIssues().some((i) => i.startsWith('POLL_OVERLAP_MIN=')));
});

test('перекриття чекпоінта: відʼємне відкидається — чекпоінт не поїде вперед', async () => {
  const { config, configIssues } = await withEnv({ POLL_OVERLAP_MIN: '-9' });
  assert.equal(config.poll.overlapMin, 15);
  assert.equal(configIssues().length, 1);
});

test('пауза між чанками: env переважує', async () => {
  const { config } = await withEnv({ POLL_CHUNK_PAUSE_MS: '4000' });
  assert.equal(config.poll.chunkPauseMs, 4000);
});

test('пауза між чанками: 0 = без паузи', async () => {
  const { config } = await withEnv({ POLL_CHUNK_PAUSE_MS: '0' });
  assert.equal(config.poll.chunkPauseMs, 0);
});

test('пауза між чанками: сміття → дефолт', async () => {
  const { config } = await withEnv({ POLL_CHUNK_PAUSE_MS: 'abc' });
  assert.equal(config.poll.chunkPauseMs, 1500);
});

test('пауза між чанками: відʼємна → дефолт', async () => {
  const { config } = await withEnv({ POLL_CHUNK_PAUSE_MS: '-5' });
  assert.equal(config.poll.chunkPauseMs, 1500);
});

test('нуль там, де нуль заборонений, теж відкочується до дефолту', async () => {
  const { config } = await withEnv({ ELEVENLABS_MIN_BALANCE_USD: '0', HTTP_TIMEOUT_MS: '0' });
  assert.equal(config.elevenlabs.minBalanceUsd, 3.31);
  assert.equal(config.http.timeoutMs, null);
});

test('порожній HTTP_TIMEOUT_MS означає «дефолт за постачальником»', () => {
  assert.equal(defaults.config.http.timeoutMs, null);
});

test('SEGMENT_CONSISTENCY_PASSES не може впасти нижче одного проходу', async () => {
  const { config } = await withEnv({ SEGMENT_CONSISTENCY_PASSES: '0' });
  assert.equal(config.report.segmentPasses, 1);
});

test('KB_CLIP_PAD_PAGES округлюється донизу і приймає 0', async () => {
  const { config } = await withEnv({ KB_CLIP_PAD_PAGES: '2.7' });
  assert.equal(config.report.kbClipPadPages, 2);
  const zero = await withEnv({ KB_CLIP_PAD_PAGES: '0' });
  assert.equal(zero.config.report.kbClipPadPages, 0);
});

test('списки номерів розбираються так само, як раніше в phoneLines', async () => {
  const { config } = await withEnv({ SHARED_EXTENSIONS: ' 901 , 907 ,, ' });
  assert.deepEqual(config.lines.shared, ['901', '907']);
});

test('порожнє значення списку лишає дефолт', async () => {
  const { config } = await withEnv({ SHARED_EXTENSIONS: '   ' });
  assert.deepEqual(config.lines.shared, ['901', '902']);
  assert.deepEqual(config.lines.excluded, ['0674738200']);
});

test('пари «номер=імʼя» віддаються сирими — їх розбирає phoneLines', async () => {
  const { config } = await withEnv({ PERSONAL_OPERATORS: '906=Тарас' });
  assert.equal(config.lines.personalRaw, '906=Тарас');
});

test('SSL вимикається для локальної бази і для sslmode=disable', async () => {
  const local = await withEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/x' });
  assert.equal(local.config.db.ssl, false);
  const disabled = await withEnv({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/x?sslmode=disable' });
  assert.equal(disabled.config.db.ssl, false);
});

test('...і лишається для віддаленої бази', async () => {
  const remote = await withEnv({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/x?sslmode=require' });
  assert.deepEqual(remote.config.db.ssl, { rejectUnauthorized: false });
});

test('CALL_LANGUAGE порожній означає автовизначення, а не порожній рядок', async () => {
  assert.equal(defaults.config.call.language, null);
  const { config } = await withEnv({ CALL_LANGUAGE: 'uk' });
  assert.equal(config.call.language, 'uk');
});

test('бот не стартує без бази й токена, і каже, чого саме бракує', () => {
  assert.deepEqual(defaults.missingConfig(['db', 'telegram']), ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN']);
});

test('інжест не стартує без бази, Binotel, OpenAI і ElevenLabs', () => {
  assert.deepEqual(
    defaults.missingConfig(['db', 'binotel', 'openai', 'elevenlabs']),
    ['DATABASE_URL', 'BINOTEL_API_KEY', 'BINOTEL_API_SECRET', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY']
  );
});

test('заповнені змінні зникають зі списку відсутніх', async () => {
  const { missingConfig } = await withEnv({ DATABASE_URL: 'postgres://u:p@localhost/x', TELEGRAM_BOT_TOKEN: 'abc' });
  assert.deepEqual(missingConfig(['db', 'telegram']), []);
});

test('ElevenLabs став ОБОВʼЯЗКОВИМ: фолбеку на OpenAI більше немає', () => {
  assert.deepEqual(defaults.REQUIRED.elevenlabs, ['ELEVENLABS_API_KEY']);
  assert.equal(defaults.config.elevenlabs.apiKey, null);
  assert.ok(defaults.missingConfig(['elevenlabs']).includes('ELEVENLABS_API_KEY'));
});

test('модель транскрипції OpenAI зникла з конфігу разом із фолбеком', () => {
  assert.equal(defaults.config.openai.transcribeModel, undefined);
});

test('здоровий конфіг не дає жодного зауваження', () => {
  assert.deepEqual(defaults.configIssues(), []);
});
