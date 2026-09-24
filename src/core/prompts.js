import { getState, setState, deleteState } from './store.js';

// Every instruction the project gives an AI model, in one place — so the owner can edit all of them
// from the bot (/prompt) instead of asking a developer to change code.
//
// Registration, not collection: each module DECLARES its own prompt next to the code that uses it
// (definePrompt) and gets back a getter. This keeps the default text beside its consumer — where it
// is maintained — while the registry still sees every prompt. Collecting the texts here instead
// would mean core/prompts.js importing bot/ modules, which is backwards, and importing the call
// modules would be circular. The bot pulls in src/core/promptsAll.js so nothing is missing from the
// menu just because a module happened not to be loaded.
//
// ⚠️ EDITING CHANGES WORDING ONLY. Everything that makes results trustworthy is enforced by CODE and
// is deliberately not editable: the JSON schemas, the "quote must be found in the manager's own
// lines" checks, the ">= MIN_EVIDENCE examples" rule, the 1-10 scale, the four sales stages, and the
// four call categories. Whatever the owner writes, an unproven claim still cannot reach a report.

const REGISTRY = new Map();

// How long a prompt stays cached in a process before it re-reads the DB. The poller is a separate
// process restarted every 15 minutes, and the bot is long-lived, so an edit has to reach both
// without a restart — but the per-call path must not pay a query per call either.
const CACHE_MS = 60_000;
const cache = new Map();

// Jobs a prompt can drive: changing the wording makes the stored answers stale, and this says which
// re-run would refresh them. `null` = nothing stored per call (report-time wording), so there is
// nothing to re-process — only the report cache to rebuild.
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

// Where the menu puts it. Order here is the order on screen.
const GROUPS = [
  { key: 'call', title: '📞 Розбір кожного дзвінка' },
  { key: 'report', title: '📊 Звіт і висновки' },
  { key: 'kb', title: '📚 База знань' },
];

/**
 * Declare an editable prompt and get its reader back.
 *
 *   const rules = definePrompt({ key: 'purpose', ..., def: DEFAULT_TEXT });
 *   const text = await rules();     // owner's version if set, otherwise the default
 */
function definePrompt(spec) {
  const entry = {
    job: null,
    // Legacy rows already in app_state keep their original key so the owner's existing edits are not
    // orphaned by the move to this registry.
    storeKey: spec.storeKey || `prompt_${spec.key}`,
    ...spec,
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

  // A DB hiccup must never stop a call from being analysed: fall back to the built-in text.
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

// Registry order follows GROUPS, then declaration order inside a group.
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
