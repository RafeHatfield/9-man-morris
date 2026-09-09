import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStore, getStore } from './get-store';
import { MemoryStore } from './memory-store';
import { RedisStore } from './redis-store';

const REST = {
  KV_REST_API_URL: 'https://example.upstash.io',
  KV_REST_API_TOKEN: 'test-token',
};

/**
 * Nothing here may reach the real environment: every case passes its own — with
 * exactly one deliberate exception, in the `getStore` describe at the bottom,
 * which owns `process.env` through `vi.stubEnv` and is the only way to observe
 * `createStore`'s `= process.env` default at all.
 */
const REAL = {
  KV_REST_API_URL: 'https://real.upstash.io',
  KV_REST_API_TOKEN: 'real-token',
  UPSTASH_REDIS_REST_URL: 'https://other.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'other-token',
};

/** A real Vercel serverless runtime: `VERCEL_ENV` is preview or production. */
const ON_VERCEL = { VERCEL: '1', VERCEL_ENV: 'production' };

let warnings: string[];

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `isDeployedRuntime` is not exported — `createStore` is its only caller, and the
 * API layer deliberately asks a different question — so the matrix is driven
 * through the one observable difference it makes: on a deployed runtime a
 * half-configured pair is fatal, everywhere else it warns and falls back.
 *
 * Every case supplies its own environment. Nothing here reads `process.env`,
 * which is the rule at the top of this file and which the previous version of
 * this suite broke by testing the bare no-argument form.
 */
describe('what counts as a deployed runtime', () => {
  const halfPair = { KV_REST_API_URL: REAL.KV_REST_API_URL };

  it.each<[string, Record<string, string>, boolean]>([
    ['nothing set', {}, false],
    ['a production deploy', { VERCEL: '1', VERCEL_ENV: 'production' }, true],
    ['a preview deploy', { VERCEL: '1', VERCEL_ENV: 'preview' }, true],
    ['vercel dev', { VERCEL: '1', VERCEL_ENV: 'development' }, false],
    [
      'a production deploy that is also mid-build',
      {
        VERCEL: '1',
        VERCEL_ENV: 'production',
        NEXT_PHASE: 'phase-production-build',
      },
      true,
    ],
    // `VERCEL=1` with no `VERCEL_ENV`, or a blank one, is a deploy. Requiring
    // the variable to be *present* used to make these three not-a-deploy, which
    // put the silent memory-store fallback one absent system variable away from
    // a production deploy. Absent, blank and unrecognised all fail closed.
    ['VERCEL without VERCEL_ENV', { VERCEL: '1' }, true],
    ['a blank VERCEL_ENV', { VERCEL: '1', VERCEL_ENV: '' }, true],
    ['a whitespace VERCEL_ENV', { VERCEL: '1', VERCEL_ENV: '   ' }, true],
    ['an unrecognised VERCEL_ENV', { VERCEL: '1', VERCEL_ENV: 'staging' }, true],
    ['VERCEL_ENV without VERCEL', { VERCEL_ENV: 'production' }, false],
    ['VERCEL that is not 1', { VERCEL: 'true', VERCEL_ENV: 'production' }, false],
    ['a blank VERCEL', { VERCEL: '', VERCEL_ENV: 'production' }, false],
    ['a padded production', { VERCEL: '1', VERCEL_ENV: ' production ' }, true],
    // The only carve-out, and the only one: `vercel dev` is a laptop.
    ['a padded development', { VERCEL: '1', VERCEL_ENV: ' development ' }, false],
  ])('%s -> deployed: %s', (_name, env, deployed) => {
    if (deployed) {
      expect(() => createStore({ ...halfPair, ...env })).toThrow(/KV_REST_API_TOKEN/);
    } else {
      expect(createStore({ ...halfPair, ...env })).toBeInstanceOf(MemoryStore);
      expect(warnings).toHaveLength(1);
    }
  });

  it('has no build carve-out, because a build never reaches the store', () => {
    // `NEXT_PHASE=phase-production-build` used to make this not-a-deploy, which
    // put one environment variable ahead of the guard — on the silent path, so
    // a production deploy carrying it served MemoryStore with no warning. Every
    // route is `force-dynamic` and `getStore()` is only called from a request
    // handler, so `createStore` is never called during a build; verified by
    // building with VERCEL=1 VERCEL_ENV=production and no credentials.
    expect(() =>
      createStore({
        NEXT_PHASE: 'phase-production-build',
        VERCEL: '1',
        VERCEL_ENV: 'production',
      }),
    ).toThrow(/no Redis variables/);
  });
});

describe('the Redis client createStore builds', () => {
  it('turns automatic deserialization off, which the Lua depends on', async () => {
    // The script compares the stored value with what this store wrote, so the
    // client must not re-encode it. Nothing else in the suite can see this: the
    // store tests inject their own fake client.
    vi.resetModules();
    const Redis = vi.fn();
    vi.doMock('@upstash/redis', () => ({ Redis }));
    try {
      const { createStore: fresh } = await import('./get-store');
      fresh({
        KV_REST_API_URL: 'https://real.upstash.io',
        KV_REST_API_TOKEN: 'real-token',
      });
      expect(Redis).toHaveBeenCalledWith({
        url: 'https://real.upstash.io',
        token: 'real-token',
        automaticDeserialization: false,
      });
    } finally {
      vi.doUnmock('@upstash/redis');
      vi.resetModules();
    }
  });
});

describe('createStore', () => {
  it('uses the memory store, quietly, when no Redis variable is set', () => {
    expect(createStore({})).toBeInstanceOf(MemoryStore);
    expect(warnings).toEqual([]);
  });

  it('refuses to serve memory on a deploy with no Redis variables at all', () => {
    // The likelier misconfiguration than a half-set pair: the Marketplace
    // integration never added. Silently serving memory here loses every room
    // between invocations while the deploy looks healthy — so it gets the same
    // signal a half-set pair gets, not the opposite one.
    expect(() => createStore({ ...ON_VERCEL })).toThrow(/no Redis variables/);
  });

  it.each([
    ['VERCEL_ENV absent', { VERCEL: '1' }],
    ['VERCEL_ENV blank', { VERCEL: '1', VERCEL_ENV: '' }],
    ['VERCEL_ENV unrecognised', { VERCEL: '1', VERCEL_ENV: 'staging' }],
    ['VERCEL_ENV whitespace', { VERCEL: '1', VERCEL_ENV: '   ' }],
  ])(
    'refuses to serve memory silently on a Vercel runtime with %s',
    (_name, env) => {
      // The exact hole the `VERCEL_ENV !== undefined` conjunct opened, and the
      // worst version of it: nothing configured is the *silent* fallback, so
      // one missing system variable turned a production deploy into a
      // `MemoryStore` with no throw and no warning at all.
      expect(() => createStore(env)).toThrow(/no Redis variables/);
      expect(warnings).toEqual([]);
    },
  );

  it('uses Redis for the Vercel Marketplace variables', () => {
    expect(
      createStore({
        KV_REST_API_URL: REAL.KV_REST_API_URL,
        KV_REST_API_TOKEN: REAL.KV_REST_API_TOKEN,
      }),
    ).toBeInstanceOf(RedisStore);
  });

  it('uses Redis for the native Upstash variables', () => {
    expect(
      createStore({
        UPSTASH_REDIS_REST_URL: REAL.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: REAL.UPSTASH_REDIS_REST_TOKEN,
      }),
    ).toBeInstanceOf(RedisStore);
  });

  it('ignores REDIS_URL once a usable REST pair is present', () => {
    expect(
      createStore({
        ...REAL,
        REDIS_URL: 'rediss://user:pass@example.upstash.io:6379',
      }),
    ).toBeInstanceOf(RedisStore);
    expect(warnings).toEqual([]);
  });

  describe('blank values count as absent', () => {
    it.each(['', '   ', '\t\n'])(
      'takes the working Upstash pair past a %j Marketplace url',
      (blank) => {
        // The whole point of the pair-wise read: `??` falls through on
        // null/undefined only, so a declared-but-blank KV url used to win and
        // hand back the memory store with a working Redis sitting right there.
        expect(
          createStore({
            KV_REST_API_URL: blank,
            KV_REST_API_TOKEN: blank,
            UPSTASH_REDIS_REST_URL: REAL.UPSTASH_REDIS_REST_URL,
            UPSTASH_REDIS_REST_TOKEN: REAL.UPSTASH_REDIS_REST_TOKEN,
          }),
        ).toBeInstanceOf(RedisStore);
        expect(warnings).toEqual([]);
      },
    );

    it.each(['', '   '])('treats a %j REDIS_URL as unset', (blank) => {
      expect(createStore({ REDIS_URL: blank })).toBeInstanceOf(MemoryStore);
      expect(warnings).toEqual([]);
    });

    it.each(['', '   '])(
      'names the variable for a %j url instead of failing inside Redis',
      (blank) => {
        // Untrimmed, '   ' is truthy: it used to reach `new Redis()` and throw
        // "invalid URL", naming nothing a human could go and fix.
        expect(() =>
          createStore({
            KV_REST_API_URL: blank,
            KV_REST_API_TOKEN: REAL.KV_REST_API_TOKEN,
            ...ON_VERCEL,
          }),
        ).toThrow(/KV_REST_API_URL/);
      },
    );

    it('refuses a blank token rather than 401ing forever', () => {
      expect(() =>
        createStore({
          KV_REST_API_URL: REAL.KV_REST_API_URL,
          KV_REST_API_TOKEN: '   ',
          ...ON_VERCEL,
        }),
      ).toThrow(/KV_REST_API_TOKEN/);
    });
  });

  describe('a test run never gets Redis', () => {
    it.each([
      ['MORRIS_E2E, which playwright.config.ts sets', { MORRIS_E2E: '1' }],
      ['VITEST, which the runner sets', { VITEST: 'true' }],
    ])('%s beats a complete, valid Redis pair', (_name, flag) => {
      // A developer who has run `vercel env pull` has real Upstash credentials
      // in their environment. Without this, `npm test` and Playwright's
      // webServer (which merges process.env) run against production Redis —
      // against GDD §8.3's "using MemoryStore".
      expect(createStore({ ...REAL, ...flag })).toBeInstanceOf(MemoryStore);
      expect(warnings).toEqual([]);
    });

    it('MORRIS_E2E keeps a half pair from taking a CI run down', () => {
      // The case the old version of this test claimed to cover, before it was
      // written with VERCEL_ENV=production in its environment and named "the
      // suite". A CI runner is not a deploy.
      //
      // `warnings`, not just the class: the half-pair fallback returns a
      // `MemoryStore` too, so `toBeInstanceOf` alone is the same answer whether
      // the lever was consulted or ignored, and this test could not observe the
      // property it is named for. The lever returns before `noRedis` is
      // reached, so silence is what separates the two paths — and under a lever
      // that only short-circuits for a complete pair, every CI and e2e cold
      // start with a stray half pair emits a spurious warning.
      expect(
        createStore({ KV_REST_API_URL: REAL.KV_REST_API_URL, MORRIS_E2E: '1' }),
      ).toBeInstanceOf(MemoryStore);
      expect(warnings).toEqual([]);
    });

    it.each([
      ['VITEST', { VITEST: 'true' }],
      ['MORRIS_E2E', { MORRIS_E2E: '1' }],
    ])('%s on a deployed runtime is refused, not resolved either way', (_name, lever) => {
      // Both silent answers have a demonstrated failure mode: honouring the
      // lever hands production a store that loses every room between
      // invocations; ignoring it points a test run at production Redis, which is
      // reachable because `vercel env pull` with system variables exposed puts
      // VERCEL=1 and VERCEL_ENV=production on a laptop. The environment cannot
      // tell the two apart, so neither does this.
      for (const creds of [{ KV_REST_API_URL: REAL.KV_REST_API_URL }, REAL]) {
        expect(() => createStore({ ...creds, ...lever, ...ON_VERCEL })).toThrow(
          /test lever/,
        );
      }
    });

    it('names both ways out of the ambiguity', () => {
      const message = (() => {
        try {
          createStore({ ...REAL, VITEST: 'true', ...ON_VERCEL });
          return '';
        } catch (e) {
          return (e as Error).message;
        }
      })();

      expect(message).toMatch(/unset the lever/);
      expect(message).toMatch(/unset VERCEL_ENV/);
    });

    it('distinguishes the two levers, which are not equally trustworthy', () => {
      // MORRIS_E2E is operator-settable, so it must be exactly '1'…
      expect(createStore({ ...REAL, MORRIS_E2E: '0' })).toBeInstanceOf(
        RedisStore,
      );
      expect(createStore({ ...REAL, MORRIS_E2E: 'true' })).toBeInstanceOf(
        RedisStore,
      );
      // …while VITEST is taken at face value, because the runner sets it — any
      // value, including 'false'.
      expect(createStore({ ...REAL, VITEST: 'false' })).toBeInstanceOf(
        MemoryStore,
      );
      // Any *non-blank* value: `VITEST` is read through the same trimming
      // `read()` as every other variable, so a declared-but-empty one is not a
      // lever. Vercel keeps a variable declared with no value, and a blank
      // `VITEST` on a deploy pointing production at the memory store is the
      // silent failure this file is built around. Nothing pinned this, and
      // `read(env, 'VITEST')` → `env['VITEST']` survived a mutation pass while
      // the line above it claimed the behaviour.
      for (const blank of ['', '   ', '\t\n']) {
        expect(createStore({ ...REAL, VITEST: blank })).toBeInstanceOf(
          RedisStore,
        );
      }
    });
  });

  describe('half-configured', () => {
    const cases: [name: string, env: Record<string, string>, names: RegExp][] = [
      [
        'a url with no token',
        { KV_REST_API_URL: REAL.KV_REST_API_URL },
        /KV_REST_API_TOKEN/,
      ],
      [
        'a token with no url',
        { UPSTASH_REDIS_REST_TOKEN: REAL.UPSTASH_REDIS_REST_TOKEN },
        /UPSTASH_REDIS_REST_URL/,
      ],
      [
        "one pair's url with the other pair's token",
        {
          KV_REST_API_URL: REAL.KV_REST_API_URL,
          KV_REST_API_TOKEN: '',
          UPSTASH_REDIS_REST_TOKEN: REAL.UPSTASH_REDIS_REST_TOKEN,
        },
        /KV_REST_API_TOKEN/,
      ],
      [
        'a bare REDIS_URL',
        { REDIS_URL: 'rediss://user:pass@example.upstash.io:6379' },
        /REST/,
      ],
    ];

    it.each<[string, Record<string, string>, string]>([
      [
        'the token, when only the url is set',
        { KV_REST_API_URL: REAL.KV_REST_API_URL },
        'KV_REST_API_TOKEN',
      ],
      [
        'the url, when only the token is set',
        { KV_REST_API_TOKEN: REAL.KV_REST_API_TOKEN },
        'KV_REST_API_URL',
      ],
    ])('names %s as the one that is missing', (_name, env, missing) => {
      // Whole message, by equality. The sentence's tail names *both* variables,
      // so a `toMatch` on either name passes whichever way round the ternary is
      // — inverting it, to blame the variable that *is* set, survived every
      // assertion here. `toThrow(string)` is a substring match and cannot rule
      // the inverted sentence out on its own either; equality can, and makes the
      // `not.toThrow` that used to sit here (which no message could fail)
      // unnecessary.
      const message = (() => {
        try {
          createStore({ ...env, ...ON_VERCEL });
          return '';
        } catch (e) {
          return (e as Error).message;
        }
      })();

      expect(message).toBe(
        `No usable Redis configuration: ${missing} is not set (blank counts as not set), but its partner is. Set both KV_REST_API_URL and KV_REST_API_TOKEN, or neither.`,
      );
    });

    it.each(cases)('throws on a deploy for %s', (_name, env, names) => {
      expect(() => createStore({ ...env, ...ON_VERCEL })).toThrow(names);
    });

    it.each(cases)(
      'warns and serves memory off a deploy for %s',
      (_name, env, names) => {
        // GDD §7.2 makes MemoryStore the store "used in tests". An ambient
        // REDIS_URL on a laptop or a CI runner must not be able to take down
        // `npm run dev`, `npm test` or the e2e suite.
        expect(createStore(env)).toBeInstanceOf(MemoryStore);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(names);
        expect(warnings[0]).toContain('in-memory');
      },
    );

    it('reports the same failure to a deploy and to a laptop', () => {
      const env = { REDIS_URL: 'rediss://x:y@z:6379' };
      const thrown = (() => {
        try {
          createStore({ ...env, ...ON_VERCEL });
          return '';
        } catch (e) {
          return (e as Error).message;
        }
      })();

      createStore(env);
      // Same diagnosis either way; only the severity differs.
      expect(warnings[0]).toContain(thrown);
    });
  });
});

/**
 * `getStore` reads the ambient `process.env`, so the test has to own it. Without
 * this the suite means something different on every machine: a developer with
 * `KV_REST_API_URL` alone in their shell gets a red run from an unrelated file,
 * and one with a full valid pair gets a *green* run that quietly built a live
 * Redis client against real credentials.
 */
const REDIS_ENV_VARS = [
  'VERCEL',
  'VERCEL_ENV',
  'REDIS_URL',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];

type GlobalWithStore = typeof globalThis & { morrisStore?: unknown };

describe('getStore', () => {
  beforeEach(() => {
    for (const name of REDIS_ENV_VARS) vi.stubEnv(name, undefined);
    delete (globalThis as GlobalWithStore).morrisStore;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as GlobalWithStore).morrisStore;
  });

  it('memoises one store on globalThis so it survives a hot reload', () => {
    const store = getStore();

    expect(getStore()).toBe(store);
    expect((globalThis as GlobalWithStore).morrisStore).toBe(store);
  });

  it('never builds a Redis client in a test run, whatever the environment says', () => {
    // This process *is* a Vitest run, and this is what stops `npm test` from
    // reaching a real Upstash when one is configured on the machine.
    vi.stubEnv('KV_REST_API_URL', REST.KV_REST_API_URL);
    vi.stubEnv('KV_REST_API_TOKEN', REST.KV_REST_API_TOKEN);

    expect(getStore()).toBeInstanceOf(MemoryStore);
  });

  it('reads the real process environment, not an empty one', () => {
    // The suite's one deliberate exception to "every case supplies its own
    // environment", and it has to be: `createStore(env: Env = process.env)` is
    // the only form `getStore()` — and therefore production — ever calls, and
    // every other test in this file passes its own object, so the default is
    // unobserved. `createStore(env: Env = {})` passes all of them, and under it
    // a production deploy holding valid Upstash credentials gets `MemoryStore`
    // *silently*: no throw, no warning, every room lost between invocations.
    //
    // The lever below is what this process actually is. A Vitest worker sets
    // `VITEST` in the real environment, so stubbing a deployed runtime on top of
    // it puts the bare form on the one branch that refuses to guess. An empty
    // default sees no lever and no VERCEL, and hands back a MemoryStore.
    expect(process.env.VITEST?.trim()).toBeTruthy();
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'production');

    expect(() => createStore()).toThrow(/test lever/);
  });

  it('would select Redis for the same variables outside a test run', () => {
    // The selection itself still works; only the runtime guard differs.
    expect(
      createStore({
        KV_REST_API_URL: REST.KV_REST_API_URL,
        KV_REST_API_TOKEN: REST.KV_REST_API_TOKEN,
      }),
    ).toBeInstanceOf(RedisStore);
  });
});
