export async function withRetry(fn, { attempts = 3, delayMs = 1000, label = 'operation' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`[retry] ${label} attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) {
        const hinted = Number(err?.retryAfterMs);
        const base = delayMs * attempt;
        const wait = Number.isFinite(hinted) && hinted > 0 ? Math.max(base, hinted + 300) : base;
        await new Promise((resolve) => setTimeout(resolve, wait + Math.floor(Math.random() * 250)));
      }
    }
  }
  throw lastErr;
}
