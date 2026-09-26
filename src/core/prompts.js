import { readFileSync } from 'node:fs';
import { getState, setState, deleteState } from './store.js';

const DEFAULTS = JSON.parse(readFileSync(new URL('./prompts.default.json', import.meta.url), 'utf8'));

function defaultText(key) {
  const raw = DEFAULTS[key];
  if (raw == null) throw new Error(`У prompts.default.json немає промпта «${key}»`);
  return Array.isArray(raw) ? raw.join('\n') : String(raw);
}


const REGISTRY = new Map();

const CACHE_MS = 60_000;
const cache = new Map();

const JOBS = {
  map: {
    title: 'Розбір дзвінка',
    what: 'категорія дзвінка, поведінки менеджера, чи представився',
    model: 'gpt-4o-mini',
    usdPerCall: 0.0004,
    warn: 'Змінює КАТЕГОРІЮ дзвінків, а отже і конверсію менеджерів.',
  },
  score: {
    title: 'Оцінка дзвінка',
    what: 'чи записався клієнт, найслабший етап, бал комунікації',
    model: 'gpt-4o-mini',
    usdPerCall: 0.0004,
    warn: 'Змінює бали й конверсію менеджерів.',
  },
  blocker: {
    title: 'Відмови СТО',
    what: 'чи відмовило саме СТО (черга / немає деталі / не наш профіль)',
    model: 'gpt-4o',
    usdPerCall: 0.006,
    warn: 'Найдорожчий прогін: працює на сильнішій моделі й у два проходи.',
  },
  decline: {
    title: 'Причини відмов клієнтів',
    what: 'чому клієнт не записався',
    model: 'gpt-4o-mini',
    usdPerCall: 0.0004,
    warn: null,
  },
  personal: {
    title: 'Особисті дзвінки',
    what: 'відокремлення особистих розмов від робочих',
    model: 'gpt-4o-mini',
    usdPerCall: 0.0004,
    warn: null,
  },
  identify: {
    title: 'Хто взяв слухавку',
    what: 'визначення менеджера на спільних номерах 901/902',
    model: 'gpt-4o-mini',
    usdPerCall: 0.0004,
    warn: 'Змінює, кому зараховані дзвінки зі спільних номерів.',
  },
};

const GROUPS = [
  { key: 'call', title: '📞 Розбір кожного дзвінка' },
  { key: 'report', title: '📊 Звіт і висновки' },
  { key: 'kb', title: '📚 База знань' },
];

function definePrompt(spec) {
  const entry = {
    job: null,
    storeKey: spec.storeKey || `prompt_${spec.key}`,
    ...spec,
    def: defaultText(spec.key),
  };
  REGISTRY.set(entry.key, entry);
  return () => getPrompt(entry.key);
}

const entryOf = (key) => REGISTRY.get(key) || null;

async function getPrompt(key) {
  const entry = entryOf(key);
  if (!entry) throw new Error(`Невідомий промпт: ${key}`);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let stored = null;
  try {
    stored = await getState(entry.storeKey);
  } catch (err) {
    console.error(`[prompts] не вдалось прочитати «${key}»: ${err.message}`);
    return entry.def;
  }
  const value = stored || entry.def;
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function promptInfo(key) {
  const entry = entryOf(key);
  if (!entry) return null;
  const stored = await getState(entry.storeKey);
  return { ...entry, value: stored || entry.def, isCustom: Boolean(stored) };
}

async function savePrompt(key, text) {
  const entry = entryOf(key);
  if (!entry) throw new Error(`Невідомий промпт: ${key}`);
  await setState(entry.storeKey, String(text).trim());
  cache.delete(key);
}

async function resetPrompt(key) {
  const entry = entryOf(key);
  if (!entry) throw new Error(`Невідомий промпт: ${key}`);
  await deleteState(entry.storeKey);
  cache.delete(key);
}

function listPrompts() {
  const all = [...REGISTRY.values()];
  return GROUPS.flatMap((g) => all.filter((e) => e.group === g.key));
}

const groupsOf = () => GROUPS.filter((g) => [...REGISTRY.values()].some((e) => e.group === g.key));
const promptsInGroup = (group) => [...REGISTRY.values()].filter((e) => e.group === group);
const jobOf = (key) => JOBS[entryOf(key)?.job] || null;

export {
  definePrompt,
  getPrompt,
  promptInfo,
  savePrompt,
  resetPrompt,
  listPrompts,
  groupsOf,
  promptsInGroup,
  entryOf,
  jobOf,
  JOBS,
  GROUPS,
};
