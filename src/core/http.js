import { httpError } from './errors.js';


const DEFAULT_TIMEOUT_MS = {
  binotel: 30_000,
  telegram: 30_000,
  openai: 120_000,
  recording: 120_000,
  elevenlabs: 300_000,
};

const FALLBACK_TIMEOUT_MS = 60_000;

function timeoutFor(provider, override) {
  if (override) return override;
  const fromEnv = Number(process.env.HTTP_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TIMEOUT_MS[provider] ?? FALLBACK_TIMEOUT_MS;
}

const isAbort = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

async function fetchRaw(provider, op, url, init = {}, { timeoutMs } = {}) {
  const ms = timeoutFor(provider, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    const reason = isAbort(err) ? `немає відповіді за ${Math.round(ms / 1000)}с` : err?.message || 'збій мережі';
    const tagged = new Error(`${provider} ${op}: ${reason}`);
    tagged.provider = provider;
    tagged.op = op;
    tagged.cause = err;
    if (isAbort(err)) tagged.name = 'TimeoutError';
    throw tagged;
  }
}

async function fetchOk(provider, op, url, init = {}, options = {}) {
  const res = await fetchRaw(provider, op, url, init, options);
  if (!res.ok) throw await httpError(provider, op, res);
  return res;
}

export { fetchOk, fetchRaw, DEFAULT_TIMEOUT_MS };
