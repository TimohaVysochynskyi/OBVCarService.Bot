import { onPoolError } from './store.js';
import { describeError } from './errors.js';
import { recordError } from './errorLog.js';
import { sendAlert } from './telegram.js';
import { alertText } from './alerts.js';

// Пастки рівня процесу: те, від чого процес умирав МИТТЄВО і повністю тихо.
//
// Таких випадків було три, і жоден не давав ні повідомлення, ні рядка в лозі, який хтось прочитав
// би: `unhandledRejection` (у Node 20 це вихід за замовчуванням), `uncaughtException` і помилка
// простійного клієнта Postgres (без слухача на пулі — теж вихід). pm2 піднімав процес назад, тож
// зовні це виглядало як «бот іноді не відповідає кілька секунд», а після `max_restarts` — як
// «бот більше не працює, і ніхто не сказав чому».
//
// ⚠️ Вихід тут ПОТРІБЕН, а не опційний. Після `uncaughtException` стан процесу невідомий, і
// продовжувати роботу небезпечніше, ніж перезапуститись: pm2 підніме чистий процес за секунди.

// Скільки чекати на відправку алерта, перш ніж усе одно вийти. Стан процесу вже зламаний, тож
// зависнути назавжди на sendAlert — гірше, ніж вийти без повідомлення.
const ALERT_DEADLINE_MS = 8000;

function installProcessTraps(source) {
  let dying = false;

  // Спільний шлях для всіх трьох випадків: розпізнати клас, записати інцидент, спробувати
  // сповістити, вийти. `dying` — щоб каскад помилок не породив десяток алертів.
  const die = async (kind, err) => {
    if (dying) return;
    dying = true;

    const described = describeError(err, { action: 'fallback', icon: '⚠️' });
    console.error(`[${source}] ${kind}: ${described.code} інцидент ${described.incident}`);
    console.error(err);

    const report = (async () => {
      await recordError(described, { source, feature: 'fallback', context: { kind } });
      await sendAlert(alertText(describeError(err, { action: 'fallback', icon: '⚠️', incident: described.incident })));
    })().catch((inner) => console.error(`[${source}] сповістити про ${kind} не вдалося: ${inner.message}`));

    await Promise.race([report, new Promise((resolve) => setTimeout(resolve, ALERT_DEADLINE_MS))]);
    process.exit(1);
  };

  process.on('unhandledRejection', (reason) => {
    die('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  process.on('uncaughtException', (err) => {
    die('uncaughtException', err);
  });

  // Помилка простійного підключення: сама база живе своїм життям (рестарт, обрив, ліміт), і пул
  // повідомляє про це поза будь-яким нашим запитом. Виходимо так само — з чистим підключенням
  // після перезапуску шансів більше, ніж із пулом у невідомому стані.
  onPoolError((err) => {
    die('poolError', err);
  });
}

export { installProcessTraps };
