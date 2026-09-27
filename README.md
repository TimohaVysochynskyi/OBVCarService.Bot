# OBV Car Service Bot

Аналітика дзвінків автосервісу. Дзвінки менеджерів через Binotel транскрибуються, класифікуються і зберігаються в Postgres із прив'язкою до менеджера; Telegram-бот віддає звіти, статистику, архів розмов і базу знань.

**Два процеси з одного репо, обидва під pm2:**

- `obv-poller` — `node src/apps/poller/index.js`, cron `*/15`: збір, транскрипція, аналіз, атрибуція.
- `obv-bot` — `node src/apps/bot/index.js`, persistent: звітність і весь інтерактив.

```bash
npm install
npm test        # уся офлайн-сітка перевірок: без мережі, без БД, без витрат
npm run poll    # один прогін інжесту
npm run bot     # Telegram-бот
```

## Як розкладений код

```
src/apps/       точки входу, і більше нічого
src/shared/     фундамент без знання домену: config · paths · http · retry · errors · time
src/platform/   адаптери: db · openai · binotel · elevenlabs · audio · telegram
src/domain/     чисті правила: категорії, етапи, напрямок, представлення, метрики діалогу
src/features/   вертикальні слайси, у кожного свій repo.js — єдиний шлях до бази
src/scripts/    одноразові інструменти (кожен = один npm-скрипт)
test/           дзеркалить src/ + invariants/
```

Напрямок залежностей (`apps → features → domain → shared`, `platform` збоку) перевіряється тестом, а не домовленістю.

## Документація

| файл | про що |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **єдине джерело правди**: архітектура, всі фічі, схема БД, env, інваріанти |
| [DEPLOY.md](DEPLOY.md) | розгортання на VPS |
| [GLOBALREPORT.md](GLOBALREPORT.md) | пояснення «Звіту за весь період» нетехнічною мовою |

Повний список npm-скриптів (беклоги, перетранскрибація, збірка звіту) — у розділі «Команди» в [CLAUDE.md](CLAUDE.md).

## Правила коду

- **У проєкті немає коментарів.** Код пояснює себе назвами; усе решта — в [CLAUDE.md](CLAUDE.md).
- ESM (`"type": "module"`), відносні імпорти з розширенням `.js`.
- Зібраний `src/features/reporting/site/app.css` **комітиться** — на VPS деплой іде з `--omit=dev`, Tailwind CLI там немає.
