// Minimal client for TypeSafe AI's System One endpoint (POST /v1/systemone).
// Zero dependencies: uses global fetch (Node 18+). `fetchImpl` is injectable for tests.

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const PRICE_PER_M_INPUT = 0.042; // USD, TypeSafe's published list price at launch (Sept 2026)

export class JevError extends Error {}

export function createJev({
  apiKey = process.env.TYPESAFE_API_KEY,
  baseUrl = process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL,
  model = process.env.AGENT_LIGHTHOUSE_MODEL || "jev-latest",
  fetchImpl = globalThis.fetch,
  retries = 4,
  timeoutMs = 30_000,
} = {}) {
  if (!apiKey) return null;
  const url = `${baseUrl.replace(/\/$/, "")}/v1/systemone`;
  const stats = { requests: 0, inputTokens: 0, model: null };

  async function ask(state, questions) {
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, state, questions }),
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < retries) { await sleep(delay); delay *= 2; continue; }
        throw new JevError(`Jev request failed: ${err.message}`);
      }
      clearTimeout(timer);
      if (res.ok) {
        const body = await res.json();
        stats.requests += 1;
        stats.inputTokens += Number(body.usage?.input_tokens ?? 0);
        stats.model = body.model ?? stats.model;
        for (const key of Object.keys(questions)) {
          if (!body.answers?.[key]) throw new JevError(`Jev response missing answer "${key}"`);
        }
        return body.answers;
      }
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) { await sleep(delay); delay *= 2; continue; }
      const text = await res.text().catch(() => "");
      throw new JevError(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  return { ask, stats, model };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run async tasks with a concurrency cap, preserving order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
