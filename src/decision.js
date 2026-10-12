/**
 * Structured yes/no, choice and score decisions with two engines, mirroring
 * akilibrain's src/lib/ai/decision-engine.ts:
 *
 *  1. Clef (`@cf/cloudflare/clef-flash` on Cloudflare Workers AI). Uses the `AI` binding
 *     when it is configured, otherwise the REST API when CLOUDFLARE_ACCOUNT_ID and
 *     CLOUDFLARE_WORKERS_AI_TOKEN (or CLOUDFLARE_API_TOKEN) are set.
 *  2. Jev (TypeSafe AI, TYPESAFE_API_KEY) as the fallback.
 *
 * `decide()` never throws. It returns null when no engine is configured or every engine
 * fails, so callers keep their existing rules and the site keeps working without AI.
 */

const CLEF_MODEL = '@cf/cloudflare/clef-flash';
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 4000;

/** Yes/no question; the answer's `noul` is the probability of "yes" (0 to 1). */
export const noul = (instructions = null, criteria) => ({ type: 'noul', instructions, criteria });
/** Pick one of the named labels; the answer's `choice` is the label. */
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
/** Score on a rubric indexed from zero; the answer's `score` is a number. */
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runClef(env, state, questions, timeoutMs) {
  const input = { model: 'clef-flash', state, questions };
  if (env.AI && typeof env.AI.run === 'function') {
    return withTimeout(env.AI.run(CLEF_MODEL, input), timeoutMs);
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_WORKERS_AI_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) return null;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLEF_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || !data.result) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data?.errors ?? data)}`.slice(0, 200));
  }
  return data.result;
}

async function runJev(env, state, questions, timeoutMs) {
  if (!env.TYPESAFE_API_KEY) return null;
  const res = await fetch(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.answers) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`.slice(0, 200));
  }
  return data;
}

/**
 * Ask the questions about `state`. Returns `{ answers, engine }`, or null when no engine
 * answered. Example: `(await decide(env, text, { spam: noul('Is this spam?') }))?.answers.spam.noul`.
 */
export async function decide(env, state, questions, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  for (const [engine, run] of [['clef', runClef], ['jev', runJev]]) {
    try {
      const result = await run(env, state, questions, timeoutMs);
      if (result?.answers) return { answers: result.answers, engine };
    } catch (err) {
      console.warn(`[decision] ${engine} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}
