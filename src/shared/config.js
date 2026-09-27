const issues = [];

const rawOf = (name) => {
  const value = process.env[name];
  return value == null ? '' : String(value).trim();
};

const str = (name, fallback = '') => rawOf(name) || fallback;

const optional = (name) => rawOf(name) || null;

function list(name, fallback) {
  const raw = rawOf(name);
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function number(name, fallback, { min = 0, exclusive = false } = {}) {
  const raw = rawOf(name);
  if (!raw) return fallback;
  const value = Number(raw);
  const fits = Number.isFinite(value) && (exclusive ? value > min : value >= min);
  if (fits) return value;
  issues.push(`${name}=${raw} — очікується число ${exclusive ? '>' : '≥'} ${min}, взято ${fallback}`);
  return fallback;
}

function sslFor(url) {
  if (/\bsslmode=disable\b/i.test(url)) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url)) return false;
  return { rejectUnauthorized: false };
}

function deepFreeze(value) {
  for (const inner of Object.values(value)) {
    if (inner && typeof inner === 'object') deepFreeze(inner);
  }
  return Object.freeze(value);
}

const config = deepFreeze({
  db: {
    url: optional('DATABASE_URL'),
    ssl: sslFor(rawOf('DATABASE_URL')),
  },
  telegram: {
    token: optional('TELEGRAM_BOT_TOKEN'),
    bootstrapChatIds: list('TELEGRAM_BOOTSTRAP_CHAT_IDS', []),
    alertFallbackChatIds: list('ALERT_FALLBACK_CHAT_IDS', []),
  },
  binotel: {
    apiKey: optional('BINOTEL_API_KEY'),
    apiSecret: optional('BINOTEL_API_SECRET'),
    baseUrl: str('BINOTEL_BASE_URL', 'https://api.binotel.com/api/4.0'),
    outageReminderMin: number('BINOTEL_OUTAGE_REMINDER_MIN', 120, { min: 0, exclusive: true }),
  },
  openai: {
    apiKey: optional('OPENAI_API_KEY'),
    analyzeModel: str('OPENAI_ANALYZE_MODEL', 'gpt-4o-mini'),
    reportModel: str('OPENAI_REPORT_MODEL', 'gpt-4o'),
    blockerModel: str('OPENAI_BLOCKER_MODEL', 'gpt-4o'),
    embedModel: str('OPENAI_EMBED_MODEL', 'text-embedding-3-small'),
  },
  elevenlabs: {
    apiKey: optional('ELEVENLABS_API_KEY'),
    sttModel: str('ELEVENLABS_STT_MODEL', 'scribe_v1'),
    numSpeakers: str('ELEVENLABS_NUM_SPEAKERS', '2'),
    minBalanceUsd: number('ELEVENLABS_MIN_BALANCE_USD', 3.31, { min: 0, exclusive: true }),
    usdPer1000Credits: number('ELEVENLABS_USD_PER_1000_CREDITS', 0.3642, { min: 0, exclusive: true }),
    outageReminderMin: number('ELEVENLABS_OUTAGE_REMINDER_MIN', 120, { min: 0, exclusive: true }),
  },
  call: {
    language: optional('CALL_LANGUAGE'),
    longPauseSec: number('LONG_PAUSE_SEC', 4, { min: 0, exclusive: true }),
  },
  lines: {
    shared: list('SHARED_EXTENSIONS', ['901', '902']),
    excluded: list('EXCLUDED_EXTENSIONS', ['0674738200']),
    personalRaw: rawOf('PERSONAL_OPERATORS'),
    numbersRaw: rawOf('LINE_NUMBERS'),
    aliasesRaw: rawOf('OPERATOR_ALIASES'),
  },
  poll: {
    jobType: str('JOB_TYPE', 'poll'),
    windowMinutes: number('POLL_WINDOW_MINUTES', 20, { min: 0 }),
    overlapMin: number('POLL_OVERLAP_MIN', 15, { min: 0 }),
    chunkPauseMs: number('POLL_CHUNK_PAUSE_MS', 1500, { min: 0 }),
    maxPendingAttempts: number('MAX_PENDING_ATTEMPTS', 20, { min: 1 }),
    errorLogKeepDays: number('ERROR_LOG_KEEP_DAYS', 30, { min: 1 }),
  },
  audio: {
    storageDir: optional('AUDIO_STORAGE_DIR'),
    minFreeMb: number('AUDIO_MIN_FREE_MB', 1024, { min: 0 }),
    clipPadSec: number('AUDIO_CLIP_PAD_SEC', 3, { min: 0 }),
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
    ffmpegTimeoutMs: number('FFMPEG_TIMEOUT_MS', 60_000, { min: 0, exclusive: true }),
  },
  report: {
    siteDir: optional('REPORT_SITE_DIR'),
    segmentPasses: Math.max(1, number('SEGMENT_CONSISTENCY_PASSES', 3, { min: 0 })),
    segmentGraceMin: number('SEGMENT_GRACE_MIN', 10, { min: 0 }),
    concurrency: number('GLOBAL_REPORT_CONCURRENCY', 1, { min: 1 }),
    pauseMs: number('GLOBAL_REPORT_PAUSE_MS', 1500, { min: 0 }),
    budgetMs: number('GLOBAL_REPORT_BUDGET_MS', 120_000, { min: 0 }),
    kbClipPadPages: Math.floor(number('KB_CLIP_PAD_PAGES', 1, { min: 0 })),
  },
  http: {
    timeoutMs: number('HTTP_TIMEOUT_MS', null, { min: 0, exclusive: true }),
  },
  liveness: {
    botMaxMin: number('BOT_HEARTBEAT_MAX_MIN', 10, { min: 0, exclusive: true }),
    pollMaxMin: number('POLL_STALE_MAX_MIN', 45, { min: 0, exclusive: true }),
  },
  backfill: {
    audioPauseMs: number('BACKFILL_AUDIO_PAUSE_MS', 1500, { min: 0 }),
    blockerPauseMs: number('BACKFILL_BLOCKER_PAUSE_MS', 2600, { min: 0 }),
    declinePauseMs: number('BACKFILL_DECLINE_PAUSE_MS', 400, { min: 0 }),
    personalPauseMs: number('BACKFILL_PERSONAL_PAUSE_MS', 400, { min: 0 }),
    rescoreIntroPauseMs: number('RESCORE_INTRO_PAUSE_MS', 500, { min: 0 }),
    retranscribeLimit: number('RETRANSCRIBE_LIMIT', 5, { min: 1 }),
    retranscribeLastLimit: number('RETRANSCRIBE_LAST_LIMIT', 7, { min: 1 }),
  },
});

const REQUIRED = {
  db: ['DATABASE_URL'],
  telegram: ['TELEGRAM_BOT_TOKEN'],
  binotel: ['BINOTEL_API_KEY', 'BINOTEL_API_SECRET'],
  openai: ['OPENAI_API_KEY'],
  elevenlabs: ['ELEVENLABS_API_KEY'],
};

const VALUE_OF = {
  DATABASE_URL: () => config.db.url,
  TELEGRAM_BOT_TOKEN: () => config.telegram.token,
  BINOTEL_API_KEY: () => config.binotel.apiKey,
  BINOTEL_API_SECRET: () => config.binotel.apiSecret,
  OPENAI_API_KEY: () => config.openai.apiKey,
  ELEVENLABS_API_KEY: () => config.elevenlabs.apiKey,
};

function missingConfig(groups) {
  const names = [];
  for (const group of groups) {
    for (const name of REQUIRED[group] || []) {
      if (!VALUE_OF[name]() && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

const configIssues = () => [...issues];

export { config, missingConfig, configIssues, REQUIRED };
