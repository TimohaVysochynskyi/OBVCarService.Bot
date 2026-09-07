import { getHeartbeat, setHeartbeat } from './store.js';
import { alertOnce, humanDuration, kyivTime } from './alerts.js';
import { NOTICES } from './errorTexts.js';

// Взаємний нагляд двох процесів: кожен відмічається «я живий», а СУСІД дивиться, чи давно була
// відмітка. Закриває найгірший клас аварії — той, після якого не приходить нічого:
//
//   • pm2 вичерпав `max_restarts` і більше не піднімає бота — разом із ним умирають авто-звіти;
//   • Telegram обірвав getUpdates, бо десь запустили другий примірник бота (409 Conflict);
//   • процес убило ядро за памʼяттю на великому PDF або довгому аудіо;
//   • cron полера знято чи процес зупинено вручну й забуто.
//
// Чому heartbeat полера, а не чекпоінт: під час аварії Binotel чекпоінт НЕ рухається навмисно, і
// нагляд по ньому кричав би «збір не запускався», хоча процес бігає щочверть години і про аварію
// вже сповістив. Відмітка ставиться на початку прогону, незалежно від його результату.
//
// ⚠️ Обидва нагляди читають і пишуть у Postgres. Якщо ляже сама база, вони теж мовчать — це
// відомий і задокументований край (див. CLAUDE.md, «свідомо не входить»).

const DEFAULT_BOT_MAX_MIN = 10; // бот відмічається щохвилини
const DEFAULT_POLL_MAX_MIN = 45; // cron полера — */15, тож 45 хв = три пропущені прогони

const minutesFromEnv = (name, fallback) => {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// Відмічатись «я живий». Для persistent-процесу (бот) — раз на інтервал; cron-процес викликає
// setHeartbeat один раз за прогін. Помилка запису не має валити нічого: якщо база недоступна,
// сусід і так це побачить.
function startHeartbeat(name, intervalMs = 60_000) {
  const beat = () =>
    setHeartbeat(name).catch((err) => console.error(`[liveness] відмітка ${name} не пройшла: ${err.message}`));
  beat();
  return setInterval(beat, intervalMs);
}

async function markAlive(name) {
  await setHeartbeat(name).catch((err) =>
    console.error(`[liveness] відмітка ${name} не пройшла: ${err.message}`)
  );
}

// Спільна перевірка для обох напрямків. `absent` (відмітки немає взагалі) — НЕ аварія: так
// виглядає перший прогін після деплою цієї фічі, і будити власника власним оновленням безглуздо.
async function checkAlive(name, { key, maxMinutes, message, recovered }) {
  const at = await getHeartbeat(name);
  if (!at) return false;
  const silentMs = Date.now() - at.getTime();
  return alertOnce(key, {
    active: silentMs > maxMinutes * 60_000,
    message: () => message(humanDuration(silentMs), kyivTime(at)),
    recovered: ({ downFor }) => recovered(downFor),
  });
}

// Викликає ПОЛЕР (він бігає щочверть години й тим самим є природним таймером для бота).
async function checkBotAlive() {
  return checkAlive('bot', {
    key: 'bot_down',
    maxMinutes: minutesFromEnv('BOT_HEARTBEAT_MAX_MIN', DEFAULT_BOT_MAX_MIN),
    message: (silentFor) => NOTICES.botDown(silentFor),
    recovered: (downFor) => NOTICES.botRecovered(downFor),
  });
}

// Викликає БОТ (він живе постійно, тож може стежити за тим, що cron перестав спрацьовувати).
async function checkPollerAlive() {
  return checkAlive('poll', {
    key: 'poll_stale',
    maxMinutes: minutesFromEnv('POLL_STALE_MAX_MIN', DEFAULT_POLL_MAX_MIN),
    message: (silentFor, lastAt) => NOTICES.pollStale(silentFor, lastAt),
    recovered: (downFor) => NOTICES.pollRecovered(downFor),
  });
}

export { startHeartbeat, markAlive, checkBotAlive, checkPollerAlive };
