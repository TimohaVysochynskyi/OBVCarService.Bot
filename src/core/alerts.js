import { getAlertState, setAlertState, clearAlertState } from './store.js';
import { sendAlert } from './telegram.js';
import { UI } from './errorTexts.js';

// Алерти: дедуп станів і формат повідомлення. У core/, бо потрібні ОБОМ процесам — інжест
// сповіщає про аварії постачальників, бот — про те, що інжест перестав бігати.
//
// Тут був не один механізм, а три майже однакові: аварія Binotel, баланс ElevenLabs і вільне
// місце на диску — кожен зі власним ключем і власною семантикою. Вони почали розходитись
// (наприклад, тільки в аварії Binotel було нагадування і повідомлення про відновлення), тож
// зведені в один `alertOnce`.
//
// Стан живе в `app_state`, а не в памʼяті, і це принципово: cron-процес завершується після
// кожного прогону, тож памʼять між прогонами не переживає нічого.

// --- формат часу для людини ------------------------------------------------------------------
// Інжест рахує все в UTC (чекпоінт — абсолютний момент), Київ потрібен ЛИШЕ для читабельності
// самого повідомлення.
function kyivTime(date) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function humanDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours === 0) return `${minutes} хв`;
  return `${hours} год ${minutes} хв`;
}

// --- текст алерта ----------------------------------------------------------------------------
// Готове повідомлення з describeError плюс ОДИН рядок технічного. Кнопки «Деталі для розробника»
// тут бути не може: алерт надсилає cron-процес, який завершується одразу після цього, тож
// натискати було б нікуди. Повний дамп лишається в лозі pm2 під тим самим кодом інциденту.
function alertText(described) {
  if (!described.technicalLine) return described.text;
  return `${described.text}\n${UI.technicalLine(described.technicalLine)}`;
}

// --- дедуп станів ----------------------------------------------------------------------------
// active   — стан проблеми ЗАРАЗ (true = зламано).
// message  — ({ first, downFor, since }) => текст. Викликається на першому алерті й на кожному
//            нагадуванні; `downFor`/`since` заповнені лише на нагадуваннях.
// recovered— ({ downFor }) => текст повідомлення про відновлення. Немає — не шлеться нічого.
// reminderMin — 0 (деф.) означає «один алерт і тиша до відновлення».
//
// Повертає true, якщо цього разу щось надіслано (потрібно тому, хто мусить знати, чи алерт уже
// пішов, — напр. jobs/index.js не дублює свій загальний алерт).
async function alertOnce(key, { active, message, recovered, reminderMin = 0 }) {
  const previous = await getAlertState(key);
  const now = Date.now();

  if (!active) {
    if (!previous) return false;
    await clearAlertState(key);
    if (!recovered) return false;
    const sinceMs = Date.parse(previous.since);
    const downFor = Number.isFinite(sinceMs) ? humanDuration(now - sinceMs) : null;
    await sendAlert(recovered({ downFor }), { icon: '✅' });
    return true;
  }

  const stamp = new Date(now).toISOString();

  if (!previous) {
    await sendAlert(message({ first: true, downFor: null, since: null }));
    await setAlertState(key, { since: stamp, lastAlertAt: stamp });
    return true;
  }

  const sinceMs = Date.parse(previous.since);
  const sinceValid = Number.isFinite(sinceMs);
  const lastMs = Date.parse(previous.lastAlertAt || previous.since);
  const lastValid = Number.isFinite(lastMs);

  // Тиша: або нагадувань не просили, або ще не час.
  if (!reminderMin) return false;
  if (lastValid && now - lastMs < reminderMin * 60000) return false;

  await sendAlert(
    message({
      first: false,
      downFor: sinceValid ? humanDuration(now - sinceMs) : null,
      since: sinceValid ? kyivTime(new Date(sinceMs)) : null,
    })
  );
  // `since` зберігається як був — інакше кожне нагадування обнуляло б тривалість простою, і
  // «лежить уже 6 годин» ніколи б не зʼявилось. Зіпсоване значення переанкорюється на зараз.
  await setAlertState(key, { since: sinceValid ? new Date(sinceMs).toISOString() : stamp, lastAlertAt: stamp });
  return true;
}

export { alertOnce, alertText, kyivTime, humanDuration };
