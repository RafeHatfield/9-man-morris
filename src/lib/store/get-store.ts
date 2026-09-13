/**
 * Picks the store implementation from the environment (GDD §7.2): Upstash Redis
 * when the Vercel Marketplace integration has provisioned one, the process-local
 * map otherwise.
 */

import { Redis } from '@upstash/redis';

import { MemoryStore } from './memory-store';
import { RedisStore } from './redis-store';
import type { RoomStore } from './types';

type Env = Record<string, string | undefined>;

/**
 * The REST credential pairs, in precedence order: the Vercel Marketplace Upstash
 * integration injects the first, a hand-made Upstash database the second.
 *
 * They are read as **pairs**. Reading url and token independently — first url
 * found, first token found — silently mixes one integration's url with the
 * other's token, and picks the memory store when a blank `KV_REST_API_URL` sits
 * in front of a working `UPSTASH_REDIS_REST_URL`.
 */
const REST_PAIRS = [
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
] as const;

/**
 * A variable's value, or `undefined` if it is absent **or blank**.
 *
 * Present-but-blank is not exotic: Vercel keeps a variable that was declared
 * with no value, and removing a Marketplace integration can leave one behind.
 * Untrimmed, `'   '` is truthy — it survives every guard here and then fails
 * inside `new Redis()` as "invalid URL", naming nothing a human can go and fix.
 */
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * True where a process-local store cannot possibly be right: a Vercel serverless
 * runtime, where every invocation is a fresh process and `MemoryStore` loses the
 * room between the request that created it and the next one.
 *
 * `VERCEL=1` and `VERCEL_ENV` are **not** deploy-only: `vercel dev` sets both,
 * and it is a local server on a laptop, so `VERCEL_ENV=development` — the one
 * value that names a laptop — is excluded. That exclusion is the *whole* of the
 * carve-out, and every other value of `VERCEL_ENV`, **including absent and
 * blank**, is a deploy.
 *
 * It used to also require `VERCEL_ENV` to be *present*, which was never argued
 * for and opened a hole: `VERCEL=1` with `VERCEL_ENV` missing read as not
 * deployed, and with no credentials that lands on the *silent* fallback — a
 * production deploy serving `MemoryStore` with no throw and no warning, restored
 * by one absent system variable. An unrecognised `VERCEL_ENV` is a question this
 * cannot answer, and of the two ways to be wrong, refusing to start a deploy is
 * recoverable in a minute and serving a store that loses every room between
 * invocations is not — so absent, blank and unknown all fail closed.
 *
 * There is deliberately **no build carve-out**. An earlier pass excluded
 * `NEXT_PHASE=phase-production-build` in case `vercel build` reached the store,
 * which put a single environment variable one step ahead of this guard — and on
 * the *silent* path, so a production deploy carrying it served `MemoryStore`
 * with no warning at all. It was also unnecessary: every route is
 * `force-dynamic` and `getStore()` is only ever called from a request handler,
 * so `createStore` is not called during a build. That was verified by building
 * with `VERCEL=1 VERCEL_ENV=production` and no Redis credentials, which would
 * throw if the store were constructed, and which succeeds.
 *
 * Deliberately not exported. The API layer scopes its own `MORRIS_E2E` timer
 * escape by a *different* question — a client request never arrives during a
 * build, so "not running on Vercel at all" is the honest condition there, with
 * no carve-outs. Two predicates that would agree on most inputs but are asking
 * different things are two definitions, not one duplicated; sharing this would
 * have coupled them and made the next change to either one a change to both.
 */
function isDeployedRuntime(env: Env): boolean {
  if (read(env, 'VERCEL') !== '1') return false;
  // `read` maps blank to `undefined`, and `undefined !== 'development'`, so a
  // declared-but-empty `VERCEL_ENV` counts as a deploy too — the safe direction.
  return read(env, 'VERCEL_ENV') !== 'development';
}

/**
 * A test lever is set: `VITEST` (any value — the runner sets it in every worker)
 * or `MORRIS_E2E === '1'` (meant to be set by hand, so exactly `'1'`).
 *
 * Either selects `MemoryStore` even against a complete, valid Redis pair, because
 * GDD §7.2 makes `MemoryStore` the store "used in tests" and §8.3 requires the
 * e2e suite to run through the real API against it. Without that, a developer who
 * has run `vercel env pull` has real Upstash credentials in their environment and
 * `npm test` — or Playwright's `webServer`, which merges `process.env` — writes
 * to production rooms.
 */
function hasTestLever(env: Env): boolean {
  return read(env, 'VITEST') !== undefined || read(env, 'MORRIS_E2E') === '1';
}

/**
 * No usable Redis. On a deployed runtime that is fatal, because serving the
 * memory store there loses every room between invocations while looking, from
 * outside, like a working deploy. Anywhere else it is the memory store, with a
 * warning whenever anything in the environment suggested Redis was wanted.
 */
function noRedis(env: Env, detail: string, quietOffDeploy = false): RoomStore {
  const message = `No usable Redis configuration: ${detail}`;
  if (isDeployedRuntime(env)) throw new Error(message);
  if (!quietOffDeploy) {
    console.warn(
      `[store] ${message} Falling back to the in-memory store; rooms will not survive a restart.`,
    );
  }
  return new MemoryStore();
}

/**
 * A complete REST pair selects `RedisStore`; a test run and anything else select
 * `MemoryStore`, fatally so on a deployed runtime.
 *
 * **On a deployed runtime, nothing configured is exactly as fatal as half
 * configured.** The previous pass threw for a half-set pair and returned memory
 * in silence for no variables at all, which is the likelier misconfiguration —
 * the Marketplace integration never added — and the same outcome. §7.2's
 * "absent → MemoryStore" licenses both or neither; it cannot license one as
 * normal and the other as fatal.
 *
 * **Off a deploy they deliberately differ, in volume only.** Both fall back to
 * `MemoryStore`, but a half pair warns and nothing at all does not: no Redis
 * variables on a laptop is the ordinary local case and has nothing to report,
 * while a half pair is someone's incomplete attempt at configuring one. The
 * severity is what the deploy decides; the warning is what the evidence of
 * intent decides.
 */
export function createStore(env: Env = process.env): RoomStore {
  if (hasTestLever(env)) {
    // A test lever on what looks like a deployed runtime is ambiguous, and both
    // ways of resolving it silently have a demonstrated failure mode: honouring
    // the lever hands production a store that loses every room between
    // invocations, and ignoring it points a test run at production Redis. The
    // environment cannot distinguish the two cases — `vercel env pull` with
    // system variables exposed puts `VERCEL=1` and `VERCEL_ENV=production` on a
    // laptop — so this refuses to guess.
    if (isDeployedRuntime(env)) {
      throw new Error(
        'A test lever (VITEST, or MORRIS_E2E=1) is set on what looks like a deployed Vercel runtime. Refusing to guess: on a real deploy, unset the lever — the memory store loses every room between invocations. On a machine that pulled production environment variables, unset VERCEL_ENV, or pull without system variables — otherwise the tests write to production Redis.',
      );
    }
    return new MemoryStore();
  }

  const pairs = REST_PAIRS.map(([urlName, tokenName]) => ({
    urlName,
    tokenName,
    url: read(env, urlName),
    token: read(env, tokenName),
  }));

  for (const pair of pairs) {
    if (pair.url !== undefined && pair.token !== undefined) {
      // Deserialization off: this store owns the JSON on both sides of the wire,
      // and the Lua update script needs the stored value to be exactly what it
      // wrote.
      return new RedisStore(
        new Redis({
          url: pair.url,
          token: pair.token,
          automaticDeserialization: false,
        }),
      );
    }
  }

  const partial = pairs.find((p) => p.url !== undefined || p.token !== undefined);
  if (partial) {
    const missing =
      partial.url === undefined ? partial.urlName : partial.tokenName;
    return noRedis(
      env,
      `${missing} is not set (blank counts as not set), but its partner is. Set both ${partial.urlName} and ${partial.tokenName}, or neither.`,
    );
  }

  if (read(env, 'REDIS_URL') !== undefined) {
    return noRedis(
      env,
      '@upstash/redis speaks REST, not the Redis wire protocol, so REDIS_URL cannot be used. Set KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN), or unset REDIS_URL.',
    );
  }

  // Nothing at all: the ordinary local case, so no warning off a deploy.
  return noRedis(
    env,
    'no Redis variables are set. Add the Upstash integration from the Vercel Marketplace, which injects KV_REST_API_URL and KV_REST_API_TOKEN.',
    true,
  );
}

// Pinned to `globalThis` so the in-memory rooms survive a Next dev hot reload —
// a fresh module instance per edit would drop every game in progress.
const globalForStore = globalThis as typeof globalThis & {
  morrisStore?: RoomStore;
};

/** The process's single store. Memoised; safe to call per request. */
export function getStore(): RoomStore {
  return (globalForStore.morrisStore ??= createStore());
}
