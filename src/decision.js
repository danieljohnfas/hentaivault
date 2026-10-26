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
 * Mistral Shieldstral 1.0 — Specialized Content Safety & Moderation Engine
 * Fast, lightweight classifier trained specifically for policy-breaking material,
 * minor protection, hate, violence, and spam without burning heavy LLM tokens.
 */
async function runShieldstral(env, state, questions, timeoutMs) {
  const token = env.SHIELDSTRAL_API_KEY || env.MISTRAL_API_KEY;
  const endpoint = env.SHIELDSTRAL_ENDPOINT || 'https://api.mistral.ai/v1/moderations';
  if (!token && !env.SHIELDSTRAL_ENDPOINT) return null;

  // Flatten state into text for content classification
  const text = typeof state === 'string'
    ? state
    : Object.values(state || {}).filter(Boolean).join('\n');
  if (!text.trim()) return null;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: 'shieldstral-latest',
      input: text,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.results?.[0]) {
    throw new Error(`Shieldstral HTTP ${res.status}: ${JSON.stringify(data)}`.slice(0, 200));
  }

  const result = data.results[0];
  const categories = result.categories || {};
  const scores = result.category_scores || {};

  // Map Shieldstral safety categories into structured decision answers
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    if (key === 'minor_risk' || key.includes('minor')) {
      const minorScore = scores.sexual_minors ?? scores.sexual_underage ?? (categories.sexual_minors ? 1.0 : 0.0);
      answers[key] = { noul: typeof minorScore === 'number' ? minorScore : 0.0 };
    } else if (key === 'verdict') {
      let v = 'ok';
      if (categories.spam) v = 'spam';
      else if (categories.sexual_minors || categories.hate_and_discrimination || categories.violence_and_threats || categories.dangerous_content) {
        v = 'harmful';
      }
      answers[key] = { choice: v };
    } else if (key === 'spam') {
      answers[key] = { choice: categories.spam ? 'spam' : 'ok', noul: scores.spam ?? (categories.spam ? 0.95 : 0.05) };
    } else if (key === 'harmful') {
      const isHarmful = Boolean(categories.sexual_minors || categories.hate_and_discrimination || categories.violence_and_threats || categories.dangerous_content);
      answers[key] = { choice: isHarmful ? 'harmful' : 'ok', noul: isHarmful ? 0.95 : 0.05 };
    }
  }

  if (Object.keys(answers).length > 0) {
    return { answers };
  }
  return null;
}

/**
 * Ask the questions about `state`. Returns `{ answers, engine }`, or null when no engine
 * answered. Evaluates specialized engines (Shieldstral for safety) before general LLMs.
 */
export async function decide(env, state, questions, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // If questions contain safety/moderation criteria, attempt Shieldstral 1.0 first
  const isSafetyQuestion = Object.keys(questions).some(k =>
    k === 'minor_risk' || k === 'verdict' || k === 'spam' || k === 'harmful'
  );

  const engines = isSafetyQuestion
    ? [['shieldstral', runShieldstral], ['clef', runClef], ['jev', runJev]]
    : [['clef', runClef], ['jev', runJev]];

  for (const [engine, run] of engines) {
    try {
      const result = await run(env, state, questions, timeoutMs);
      if (result?.answers) return { answers: result.answers, engine };
    } catch (err) {
      console.warn(`[decision] ${engine} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}
