import { config } from '../../shared/config.js';
import { fetchOk } from '../../shared/http.js';
import { withRetry } from '../../shared/retry.js';

const BASE_URL = 'https://api.openai.com/v1';
const WINDOW_MS = 60_000;
const DEFAULT_TPM = 30_000;
const CHARS_PER_TOKEN = 2;

const TPM_BY_MODEL = { 'gpt-4o': DEFAULT_TPM };

const PRICE_PER_MTOK = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
};

const usage = new Map();
const spent = new Map();
let queue = Promise.resolve();

function requireKey(op) {
  if (config.openai.apiKey) return config.openai.apiKey;
  const err = new Error(`openai ${op}: OPENAI_API_KEY is not set`);
  err.provider = 'openai';
  err.op = op;
  err.status = 401;
  throw err;
}

let transport = (op, path, init, options) => {
  const headers = { ...init.headers, Authorization: `Bearer ${requireKey(op)}` };
  return fetchOk('openai', op, `${BASE_URL}${path}`, { ...init, headers }, options);
};

function useTransport(fn) {
  const previous = transport;
  transport = fn;
  return () => { transport = previous; };
}

const limitFor = (model) => TPM_BY_MODEL[model] ?? null;

function estimateTokens(body) {
  const text = JSON.stringify(body ?? '');
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function windowTokens(model, now) {
  const log = spent.get(model) || [];
  const fresh = log.filter((e) => now - e.at < WINDOW_MS);
  spent.set(model, fresh);
  return fresh.reduce((sum, e) => sum + e.tokens, 0);
}

function waitMsFor(model, estimate, now) {
  const limit = limitFor(model);
  if (!limit) return 0;
  const used = windowTokens(model, now);
  if (used + estimate <= limit || estimate > limit) return 0;
  const log = spent.get(model) || [];
  let freed = 0;
  for (const entry of log) {
    freed += entry.tokens;
    if (used - freed + estimate <= limit) return Math.max(0, entry.at + WINDOW_MS - now);
  }
  return WINDOW_MS;
}

function reserve(model, tokens) {
  const log = spent.get(model) || [];
  log.push({ at: Date.now(), tokens });
  spent.set(model, log);
  return log[log.length - 1];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function throttled(model, body, run) {
  const estimate = estimateTokens(body);
  const start = queue.then(async () => {
    const wait = waitMsFor(model, estimate, Date.now());
    if (wait > 0) await sleep(wait);
    return reserve(model, estimate);
  });
  queue = start.catch(() => {});
  const entry = await start;
  const result = await run();
  const actual = result?.usage?.total_tokens;
  if (Number.isFinite(actual)) entry.tokens = actual;
  return result;
}

function record(model, data) {
  const stat = usage.get(model) || { calls: 0, promptTokens: 0, completionTokens: 0 };
  stat.calls += 1;
  stat.promptTokens += Number(data?.usage?.prompt_tokens ?? 0);
  stat.completionTokens += Number(data?.usage?.completion_tokens ?? 0);
  usage.set(model, stat);
}

function usdOf(model, stat) {
  const price = PRICE_PER_MTOK[model];
  if (!price) return null;
  return (stat.promptTokens * price.input + stat.completionTokens * price.output) / 1_000_000;
}

function usageReport() {
  const models = [...usage.entries()].map(([model, stat]) => ({ model, ...stat, usd: usdOf(model, stat) }));
  const known = models.filter((m) => m.usd != null);
  return {
    models,
    calls: models.reduce((n, m) => n + m.calls, 0),
    usd: known.length === models.length ? known.reduce((n, m) => n + m.usd, 0) : null,
  };
}

function usageLine() {
  const report = usageReport();
  if (!report.calls) return 'запитів до OpenAI не було';
  const parts = report.models.map((m) =>
    `${m.model}: ${m.calls} запит(ів), ${m.promptTokens + m.completionTokens} токенів` +
    (m.usd == null ? ', ціна невідома' : `, $${m.usd.toFixed(4)}`));
  const total = report.usd == null ? '' : ` | разом $${report.usd.toFixed(4)}`;
  return `${parts.join(' · ')}${total}`;
}

function resetUsage() {
  usage.clear();
  spent.clear();
}

async function post(path, { op, body, model, attempts = 2, delayMs = 2000, label }) {
  return withRetry(
    () =>
      throttled(model, body, async () => {
        const res = await transport(op, path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        record(model, data);
        return data;
      }),
    { attempts, delayMs, label: label || `OpenAI ${op}` }
  );
}

async function postForm(path, { op, form, attempts = 2, delayMs = 2000, label }) {
  return withRetry(
    async () => {
      const res = await transport(op, path, { method: 'POST', headers: {}, body: form });
      return res.json();
    },
    { attempts, delayMs, label: label || `OpenAI ${op}` }
  );
}

async function get(path, { op, timeoutMs }) {
  return transport(op, path, { headers: {} }, { timeoutMs });
}

export { post, postForm, get, useTransport, usageReport, usageLine, resetUsage, estimateTokens, waitMsFor, TPM_BY_MODEL, PRICE_PER_MTOK };
