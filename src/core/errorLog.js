import { insertErrorLog, getErrorLogByIncident } from './store.js';
import { appError, describeError } from './errors.js';

// Журнал інцидентів: запис із будь-якого з двох процесів.
//
// Сенс не в спостережуваності заради спостережуваності. Без журналу клієнт міг сказати розробнику
// лише «не працює», а розробник мусив лізти по SSH і шукати потрібний рядок серед 20 тисяч у лозі
// pm2 за приблизним часом. Тепер у повідомленні про помилку є код інциденту, і за ним у боті
// (`/log`) видно все — без сервера й без здогадок.
//
// ⚠️ Запис ніколи не кидає далі. Якщо зламалась саме база, спроба записати теж не пройде — і це не
// має ні прикрити початкову помилку, ні завалити процес. Тоді лишається лог pm2, як і було.

const SOURCES = new Set(['bot', 'poll']);

async function recordError(described, { source, feature = null, telegramId = null, context = null } = {}) {
  try {
    await insertErrorLog({
      incident: described.incident,
      code: described.code,
      process: SOURCES.has(source) ? source : 'bot',
      feature,
      telegramId,
      // У короткий `message` йде однорядкове технічне, у `technical` — повний дамп. Так список
      // інцидентів читається без розгортання кожного.
      message: described.technicalLine,
      technical: described.technical,
      context,
    });
  } catch (err) {
    console.error(`[errorLog] інцидент ${described.incident} не записано: ${err.message}`);
  }
}

// Проблема, за якою немає винятку: клас відомий, а кидати нічого. Так у журнал потрапляють тихі
// провали — наприклад, `callback_data` вийшла за 64 байти, і Telegram відкинув усю клавіатуру:
// раніше про це знав лише console.error, тобто фактично ніхто.
async function noteIssue(code, { source, feature = null, context = null, detail = null } = {}) {
  const described = describeError(appError(code, { message: detail || code }), { action: feature || 'fallback' });
  console.error(`[${source || 'bot'}] ${described.code} інцидент ${described.incident}: ${detail || '—'}`);
  await recordError(described, { source, feature, context });
  return described;
}

// Технічні деталі за кодом інциденту — те, що бере кнопка «Деталі для розробника», коли памʼять
// процесу вже не має запису (бот перезапускався). Ніколи не кидає.
async function lookupIncident(incident) {
  try {
    return await getErrorLogByIncident(incident);
  } catch (err) {
    console.error(`[errorLog] інцидент ${incident} не прочитано: ${err.message}`);
    return null;
  }
}

export { recordError, noteIssue, lookupIncident };
