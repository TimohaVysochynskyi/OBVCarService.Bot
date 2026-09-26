import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSrc, bytes } from '../helpers/repo.js';

process.env.DATABASE_URL = 'postgres://x:x@127.0.0.1:1/x';

const R = await import('../../src/bot/promptRegistry.js');
const { registerPrompt } = await import('../../src/bot/prompt.js');
const { RUNNERS } = await import('../../src/bot/reprocess.js');
const { JOBS } = await import('../../src/core/prompts.js');

const prompts = R.listPrompts();
const promptSrc = readSrc('bot/prompt.js');
const reprocess = readSrc('bot/reprocess.js');

const handlers = [];
const middleware = [];
registerPrompt({ callbackQuery: (pattern) => handlers.push(pattern), command: () => {}, use: (fn) => middleware.push(fn) });
const matches = (cb) => handlers.filter((p) => (typeof p === 'string' ? p === cb : p.test(cb))).length;

const emitted = ['prompt', 'prompt:stop', 'prompt:rep'];
for (const g of R.groupsOf()) emitted.push(`prompt:g:${g.key}`);
for (const e of prompts) {
  emitted.push(`prompt:o:${e.key}`, `prompt:v:${e.key}`, `prompt:e:${e.key}`, `prompt:sv:${e.key}`,
    `prompt:r:${e.key}`, `prompt:rok:${e.key}`);
  if (e.job) {
    emitted.push(`prompt:a:${e.key}`, `prompt:blk:${e.key}`, `prompt:ac:${e.key}:all`,
      `prompt:ac:${e.key}:b1`, `prompt:ac:${e.key}:b10`, `prompt:go:${e.key}:all`, `prompt:go:${e.key}:b7`);
  } else {
    emitted.push(`prompt:cache:${e.key}`);
  }
}

const call = (o = {}) => ({ internalNumber: '903', callPurpose: 'sales', isSuccess: false, dealBlocker: null, ...o });

test('у меню всі 13 інструкцій', () => {
  assert.equal(prompts.length, 13);
});

test('кожна має кнопку, заголовок, пояснення і непорожній стандартний текст', () => {
  for (const e of prompts) {
    assert.ok(e.button && e.title && e.about, `неповний опис: ${e.key}`);
    assert.ok(typeof e.def === 'string' && e.def.length > 50, `порожній стандартний текст: ${e.key}`);
    assert.ok(e.storeKey, `немає ключа сховища: ${e.key}`);
  }
});

test('ключі не дублюються — жодна не перетирає чужий текст', () => {
  const keys = prompts.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(prompts.map((p) => p.storeKey)).size, keys.length);
});

test('наявні власні тексти не загубляться — старі ключі збережено', () => {
  assert.equal(prompts.find((p) => p.key === 'reportGuidance').storeKey, 'analyze_prompt');
  assert.equal(prompts.find((p) => p.key === 'score').storeKey, 'score_rubric');
});

test('кожен перерахунок, на який посилається інструкція, реально існує', () => {
  for (const e of prompts) {
    if (!e.job) continue;
    assert.ok(JOBS[e.job], `невідомий перерахунок: ${e.job}`);
    assert.ok(RUNNERS[e.job], `немає раннера: ${e.job}`);
  }
});

test('у кожного перерахунку є модель і ціна за дзвінок', () => {
  for (const [job, meta] of Object.entries(JOBS)) {
    assert.ok(RUNNERS[job], `job без раннера: ${job}`);
    assert.ok(meta.usdPerCall > 0 && meta.model, `немає ціни/моделі: ${job}`);
  }
});

test('усі кнопки розділу мають рівно один обробник', () => {
  for (const cb of emitted) assert.equal(matches(cb), 1, `обробників ${matches(cb)} замість 1: ${cb}`);
});

test('схожі назви кнопок не перехоплюють одна одну', () => {
  assert.equal(matches('prompt:rep'), 1);
  assert.equal(matches('prompt:rok:score'), 1);
});

test('є middleware, що прибирає тимчасовий контент перед кожним кроком', () => {
  assert.equal(middleware.length, 1);
});

test('прибирання спрацьовує на БУДЬ-якій кнопці розділу, зокрема на «Назад»', () => {
  assert.ok(/cq\.startsWith\('prompt'\)\) await dropTemp/.test(promptSrc));
});

test('переглянутий текст промпта запамʼятовується як тимчасовий', () => {
  assert.ok(/const ids = await sendLong\([\s\S]{0,200}?rememberTemp\(ctx, ids\)/.test(promptSrc));
});

test('видалення не падає, якщо повідомлення вже немає', () => {
  assert.ok(/deleteMessage\(ctx\.chat\.id, id\)\.catch/.test(promptSrc));
});

test('найдовша кнопка вкладається в дозволені Telegram 64 байти', () => {
  const longest = emitted.reduce((x, y) => (bytes(y) > bytes(x) ? y : x));
  assert.ok(bytes(longest) <= 64, `${longest} = ${bytes(longest)} Б`);
});

test('бал перераховується лише на угодах', () => {
  assert.equal(RUNNERS.score.applies(call({ callPurpose: 'info' })), false);
  assert.equal(RUNNERS.score.applies(call({ callPurpose: 'sales' })), true);
});

test('закрита угода не перевіряється на відмову СТО', () => {
  assert.equal(RUNNERS.blocker.applies(call({ isSuccess: true })), false);
});

test('причина клієнта питається лише там, де СТО могло взяти роботу', () => {
  assert.equal(RUNNERS.decline.applies(call({ dealBlocker: 'no_slot' })), false);
  assert.equal(RUNNERS.decline.applies(call({ dealBlocker: 'none' })), true);
});

test('«хто взяв слухавку» стосується лише спільних номерів', () => {
  assert.equal(RUNNERS.identify.applies(call({ internalNumber: '903' })), false);
  assert.equal(RUNNERS.identify.applies(call({ internalNumber: '901' })), true);
});

test('перекласифікація особистих не чіпає угоди', () => {
  assert.equal(RUNNERS.personal.applies(call({ callPurpose: 'sales' })), false);
  assert.equal(RUNNERS.personal.applies(call({ callPurpose: 'other' })), true);
});

test('розбір дзвінка застосовується до всіх', () => {
  assert.equal(RUNNERS.map.applies(call()), true);
});

test('збій рецензента не записується як «відмови не було»', () => {
  assert.ok(/if \(res\.unchecked\) return;/.test(reprocess));
});

test('перекласифікація не може зробити дзвінок угодою', () => {
  assert.ok(/NON_SALES_PURPOSES\.includes\(purpose\)/.test(reprocess));
});

test('найдорожчий перерахунок іде з паузою 2.6с', () => {
  assert.ok(/PAUSE_MS = \{ blocker: 2600 \}/.test(reprocess));
});

test('збереження тексту тільки через підтвердження', () => {
  assert.ok(/prompt:sv:/.test(promptSrc) && /Дійсно замінити цю інструкцію/.test(promptSrc));
});

test('перед запуском показується порахована вартість, а не здогад', () => {
  assert.ok(/Орієнтовна вартість/.test(promptSrc) && /await estimate\(/.test(promptSrc));
});

test('після перерахунку застарілі висновки звіту скидаються', () => {
  assert.ok(/invalidateReportCache/.test(promptSrc));
});

test('перезбирання звіту — окреме питання з попередженням про оплату', () => {
  assert.ok(/Перезібрати звіт зараз/.test(promptSrc) && /окрема, платна дія/.test(promptSrc));
});

test('від старого хаба на дві інструкції не лишилось посилань', () => {
  assert.ok(!/getAnalyzePromptInfo|getScoreRubricInfo|EDITABLE/.test(promptSrc));
});

test('кожен промпт справді читається з реєстру там, де використовується', () => {
  for (const [consumer, getter] of [
    ['core/analyzeCall.js', 'behaviourRules'],
    ['core/analyzeCall.js', 'purposeRules'],
    ['core/analyzeCall.js', 'introRules'],
    ['core/classifyCall.js', 'getScoreRubric'],
    ['core/dealBlocker.js', 'blockerPrompt'],
    ['core/dealBlocker.js', 'blockerReviewPrompt'],
    ['core/clientDecline.js', 'declinePrompt'],
    ['core/classifyPersonal.js', 'personalPrompt'],
    ['core/classifyPersonal.js', 'purposeRules'],
    ['core/identifyManager.js', 'identifyPrompt'],
    ['bot/kb.js', 'kbAnswerPrompt'],
    ['bot/analyze.js', 'mergePrompt'],
    ['bot/analyze.js', 'verifyPrompt'],
    ['bot/analyze.js', 'getAnalyzePrompt'],
  ]) {
    assert.ok(readSrc(consumer).includes(`await ${getter}()`), `${consumer}: ${getter}() не викликається`);
  }
});

test('жорстко зашитих системних промптів не лишилось', () => {
  for (const f of ['core/analyzeCall.js', 'core/dealBlocker.js', 'core/identifyManager.js', 'bot/kb.js']) {
    assert.ok(!/content: (SYSTEM_PROMPT|VERIFY_SYSTEM|ANSWER_SYSTEM|SYSTEM)\b/.test(readSrc(f)), `${f}: лишився зашитий промпт`);
  }
});
