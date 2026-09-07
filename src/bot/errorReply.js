import { InlineKeyboard } from 'grammy';
import { describeError } from '../core/errors.js';
import { recordError, lookupIncident } from '../core/errorLog.js';
import { UI } from '../core/errorTexts.js';
import { sendLong } from './ui.js';
import { featureOf } from './access.js';

// Показ помилок користувачу бота.
//
// До цього 66 із 70 хендлерів не мали жодного catch: будь-яке падіння доходило лише до
// `bot.catch`, який писав рядок у консоль. Людина бачила кнопку, що нічого не зробила — а якщо
// операція була довга, то ще й зникнення напису «⏳ …» (його прибирає `withProgress` у finally).
// Тому тут не обгортка на кожен хендлер, а ОДИН middleware (`errorGuard`), який ловить усе, що
// летить із будь-якого місця ланцюжка, і завжди щось відповідає.
//
// Тексти — у core/errorTexts.js, розпізнавання класу — у core/errors.js. Тут лише доставка.

// --- памʼять технічних деталей --------------------------------------------------------------
// Гаряче сховище на час життя процесу; повна правда лежить у журналі інцидентів (`error_log`,
// екран `/log`). Памʼять тут не для надійності, а щоб типовий випадок «натиснув деталі одразу»
// не ходив у базу.
const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;
const DETAILS_MAX = 300;
const details = new Map(); // incident -> { code, at, technical }

function remember(incident, code, technical) {
  details.set(incident, { code, at: Date.now(), technical });
  // Найстаріші вставлені першими, тож достатньо зрізати з початку.
  for (const [key, value] of details) {
    if (details.size <= DETAILS_MAX && Date.now() - value.at < DETAILS_TTL_MS) break;
    details.delete(key);
  }
}

function recall(incident) {
  const found = details.get(incident);
  if (!found) return null;
  if (Date.now() - found.at >= DETAILS_TTL_MS) {
    details.delete(incident);
    return null;
  }
  return found;
}

// --- яка саме дія не вдалася -----------------------------------------------------------------
// Заголовок повідомлення пишеться в термінах дії людини, тож треба знати, що вона робила.
// Основа — той самий `featureOf`, що вирішує доступ; кілька дій виділені точніше, бо всередині
// однієї фічі вони для користувача виглядають як різні речі («відкрити архів» vs «надіслати запис»).
const CALLBACK_ACTIONS = [
  [/^arch:play:/, 'archive_audio'],
  [/^report:(exp|phr):/, 'report_details'],
  [/^stat:go:/, 'report'],
];

// Вільний текст фічею не класифікується (його маршрутизує ctx.session.awaiting), тому крок беремо
// звідти — інакше людина, що вводила текст промпту, отримала б заголовок «Дію не виконано».
const AWAITING_ACTIONS = {
  kb_question: 'kb_ask',
  prompt: 'prompt',
  role_add: 'roles',
  settings_add: 'settings',
  save_phone: 'phone',
};

function actionOf(ctx) {
  const cq = ctx.callbackQuery?.data;
  if (cq) {
    for (const [re, action] of CALLBACK_ACTIONS) if (re.test(cq)) return action;
  }
  const awaiting = ctx.session?.awaiting?.type;
  if (awaiting && AWAITING_ACTIONS[awaiting]) return AWAITING_ACTIONS[awaiting];
  if (ctx.message?.document) return 'kb_edit';
  return featureOf(ctx) || 'fallback';
}

// --- доставка --------------------------------------------------------------------------------

// Розповісти користувачу про помилку. Ніколи не кидає далі: якщо не вдалося навіть це, лишається
// запис у лозі, і бот однаково продовжує працювати.
async function reportToUser(ctx, err, { action, subject } = {}) {
  const resolved = action || actionOf(ctx);
  const described = describeError(err, { action: resolved, subject });
  remember(described.incident, described.code, described.technical);
  await recordError(described, {
    source: 'bot',
    feature: resolved,
    telegramId: ctx.from?.id,
    context: {
      chatId: ctx.chat?.id ?? null,
      callback: ctx.callbackQuery?.data ?? null,
      awaiting: ctx.session?.awaiting?.type ?? null,
      subject: subject ?? null,
    },
  });

  // Лог — з тим самим кодом інциденту, що бачить користувач: саме за ним розробник знаходить
  // подробиці, коли клієнт переслав повідомлення.
  console.error(
    `[bot] ${described.code} інцидент ${described.incident} (${resolved}, chat ${ctx.chat?.id ?? '—'}): ` +
      `${described.technicalLine}\n${described.technical}`
  );

  // Спінер на кнопці треба зняти обовʼязково, інакше Telegram крутить його до таймауту. Текст у
  // сповіщенні дублює заголовок, щоб хоч щось було видно навіть якщо саме повідомлення не пройде.
  if (ctx.callbackQuery) {
    await ctx
      .answerCallbackQuery({ text: described.text.split('\n')[0].slice(0, 190) })
      .catch(() => {});
  }

  const chatId = ctx.chat?.id;
  if (chatId == null) return described;

  const keyboard = new InlineKeyboard()
    .text(UI.detailsButton, `err:d:${described.incident}`)
    .row()
    .text('« Назад до меню', 'menu');

  // Без parse_mode і через sendLong: текст помилки не має власної розмітки, а падіння самого
  // повідомлення про помилку (задовге / крива розмітка) залишило б людину зовсім без відповіді.
  await sendLong(ctx.api, chatId, described.text, { replyMarkup: keyboard }).catch((sendErr) => {
    console.error(`[bot] не вдалося доставити повідомлення про помилку: ${sendErr.message}`);
  });
  return described;
}

// Middleware-перехоплювач. Ставиться ПІСЛЯ session (щоб був ctx.session) і ПЕРЕД перевіркою
// доступу — бо `getUser` читає роль із бази на кожен апдейт, і падіння Postgres теж має
// перетворюватись у зрозуміле повідомлення, а не в мертвого бота.
async function errorGuard(ctx, next) {
  try {
    await next();
  } catch (err) {
    await reportToUser(ctx, err);
  }
}

// Остання сітка: помилки, що виникли поза ланцюжком middleware (наприклад, у самому session або
// вже в обробнику errorGuard). grammy віддає тут BotError із загорнутою причиною і контекстом.
function installBotCatch(bot) {
  bot.catch(async (botErr) => {
    const err = botErr?.error ?? botErr;
    const ctx = botErr?.ctx;
    if (!ctx) {
      console.error(`[bot] помилка без контексту: ${err?.message || err}`);
      return;
    }
    try {
      await reportToUser(ctx, err);
    } catch (inner) {
      console.error(`[bot] помилка в обробнику помилок: ${inner.message}`);
    }
  });
}

// Кнопка «Деталі для розробника». Навмисно доступна всім ролям, а не лише адміну: сенс кнопки в
// тому, щоб людина, яка натрапила на помилку, могла переслати подробиці розробнику — а натрапити
// може й менеджер. Секретів у дампі немає (ключі в повідомлення про помилку не потрапляють).
function registerErrorActions(bot) {
  bot.callbackQuery(/^err:d:([0-9A-Z]{4})$/, async (ctx) => {
    const incident = ctx.match[1];
    await ctx.answerCallbackQuery();
    // Памʼять процесу -> журнал у базі. Друге потрібне після перезапуску бота і для інцидентів,
    // які створив ІНШИЙ процес (алерти інжесту): їх ця памʼять не бачила ніколи.
    const found = recall(incident) || (await lookupIncident(incident));
    if (!found?.technical) {
      await ctx.reply(UI.detailsGone);
      return;
    }
    await sendLong(
      ctx.api,
      ctx.chat.id,
      `${UI.detailsTitle(found.code, incident)}\n\n${found.technical}`
    );
  });
}

export { errorGuard, installBotCatch, registerErrorActions, reportToUser, actionOf };
