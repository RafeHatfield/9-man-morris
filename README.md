# Morris

A mobile-first web [Nine Men's Morris](https://en.wikipedia.org/wiki/Nine_men%27s_morris). Start a game, send a friend the link, play. No accounts, no lobby.

- **Online** — tap **New game**, pick a turn timer, share the link. The first other visitor takes Black; anyone after that watches.
- **Hot-seat** — `/local`, two players on one device.
- **Per-turn timer** with a **Claim win** button when the opponent's clock runs out, **rematch** with colours swapped, resign and offer-draw.

`GDD.md` is the source of truth for what this is and how it behaves. `DECISIONS.md` records the choices it left open.

## Run it locally

```bash
npm install
npx playwright install chromium   # only needed for the e2e suite
npm run dev                       # http://localhost:3000
```

No cloud resources are needed for local development or for any test: with no Redis environment variables set, rooms live in an in-memory store inside the Next process.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` | Production build — must be clean, zero type errors, zero warnings |
| `npm start` | Serve the production build |
| `npm test` | Vitest once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with coverage; fails under 100% branch coverage on `src/lib/engine` |
| `npm run test:e2e` | Builds, serves on :3100, runs Playwright at 360×740 and 390×844 |
| `npm run lint` | ESLint, `--max-warnings 0` |
| `npm run typecheck` | `next typegen && tsc --noEmit` — run typegen first on a fresh checkout, or Next's generated route types are missing |

## Deploy to Vercel

1. Push the repo to GitHub and import it into Vercel. No build settings to change.
2. In the Vercel project: **Storage → Marketplace → Upstash Redis → create** (the free plan is enough). Vercel injects the two environment variables below into every environment.
3. Redeploy. Open the URL on a phone, tap **New game**, send someone the link.

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `KV_REST_API_URL` | One pair, on any deployed runtime | The Upstash Redis REST endpoint. Injected by the Vercel Marketplace integration. |
| `KV_REST_API_TOKEN` | One pair, on any deployed runtime | The Upstash REST token. Injected alongside the URL. |

`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are the second accepted **pair**, for a database created directly in the Upstash console rather than through the Vercel Marketplace. What a deployed runtime requires is *one complete pair*, not either named variable: the two are read as pairs, `KV_` first, and a url is only ever used with its own partner token — a `KV_REST_API_URL` is never married to an `UPSTASH_REDIS_REST_TOKEN`. Set both halves of one pair; mixing halves of different pairs reads as half-configured.

A **blank or whitespace-only value counts as unset** everywhere in this section — Vercel keeps a variable that was declared with no value, so this is not an exotic case. Surrounding whitespace is trimmed everywhere too, with one exception called out in its own row below: the timer half of `MORRIS_E2E` compares the raw value.

With no pair set, the app uses the in-memory store — right for local development and tests, and refused outright on a deployed runtime, where each serverless invocation would otherwise start with no rooms and the deploy would look healthy while losing every game.

Anything in between — a REST URL without its token, or a bare `REDIS_URL`, which is a TCP URL `@upstash/redis` cannot use — means somebody intended Redis and did not finish. **On a deployed runtime that throws**, because a silent fallback would drop every room between requests while looking, from the outside, exactly like a working deploy. Anywhere else it prints a warning and serves the in-memory store, so half-configured credentials cannot stop you working — except under a test lever (below), which is read before the credentials are, so there is nothing to warn about.

A deployed runtime throws in one further case, whatever the credentials say: **either test lever set on a deploy**.

Throughout this section, **a deployed runtime** means `VERCEL=1` with a `VERCEL_ENV` that is not `development`. Absent, blank and unrecognised values all count as one: the guard fails closed, because the alternative is a deploy that quietly serves the in-memory store, loses every room between invocations, and looks healthy from outside. So `VERCEL=1` on its own is a deploy, and so is `VERCEL_ENV=staging`. That covers production and preview; it is not your machine, and it is not `vercel dev`, which sets `VERCEL_ENV=development` — the one carve-out.

| Variable | Set it? | What it does |
|---|---|---|
| `VITEST` | Set by the test runner | Not yours to set, and listed because it is a lever, not a label. **Any non-blank value** selects the in-memory store ahead of everything, including a valid Redis pair. On a **deployed runtime it throws** rather than being ignored: the server cannot tell a deploy that was handed a test variable from a laptop that pulled production credentials, and both silent answers are wrong — honour it and production loses every room, ignore it and a test run writes to real Redis. So a stray `VITEST` on production is a dead site rather than a slow leak: loud, and fixed by unsetting one variable. Under `vercel dev` it is neither ignored nor fatal — it simply selects the memory store, so a stray `VITEST` in Vercel's Development environment will quietly cost you your rooms locally. A declared-but-blank `VITEST` is not set at all, and does nothing anywhere. |
| `MORRIS_E2E` | **Never in any Vercel environment, Development included** | A test-only flag (GDD §8.3) with two halves, switched off by different conditions and reading the value differently. Only the value `1` does anything at all, in either half — `MORRIS_E2E=true` and `MORRIS_E2E=2` are no-ops everywhere, which makes it *stricter* than `VITEST`, not looser. The **store** half then behaves like `VITEST`: memory store off a deploy, a throw on one; it trims, so `" 1 "` counts. The **timer** half lets `POST /api/game` accept a *positive* turn timer outside §5.3's four choices — `0` and negatives are still refused — which is how the e2e drives a timeout claim in seconds; it compares the raw flag value, so `" 1 "` does **not** count, and it is off whenever `VERCEL=1` — production, preview, `vercel dev` and the build step alike — so it cannot hand anyone a one-millisecond clock. A padded value therefore splits the flag: store half on, timer half off. `playwright.config.ts` sets it for the test server; nothing else should. |

On Redis, a room expires seven days after its last **write** — a move, but also a join, an offer, a rematch or a timeout claim — and a room that is created and never played expires seven days after creation. The in-memory store has no expiry at all: its rooms live and die with the process, which is every `npm run dev`, `vercel dev`, `npm test` and e2e run.

## How it is put together

| Path | What lives there |
|---|---|
| `src/lib/engine` | The rules. Pure TypeScript, zero dependencies, no React, no clock, no I/O. 100% branch coverage. |
| `src/lib/store` | `RoomStore` — the in-memory implementation and the Upstash Redis one, with optimistic concurrency on a room `version`. |
| `src/lib/api` | The wire contract and the shared request-handling layer. |
| `src/app/api` | The route handlers. Every mutation goes through the engine, server-side. |
| `src/lib/client` | The browser half of online play: one door for every request, the poll, and the rules for when a seat is given up. |
| `src/components` | The SVG board and the chrome around it. No rules logic — the board is driven by `GameState` plus a list of legal actions. |
| `src/app` | `/` (new game), `/g/[roomId]` (online), `/local` (hot-seat). |

The server is the only authority. A client sends an intent plus the version it thinks it is acting on, and adopts whatever the server returns. Clients poll `GET /api/game/[id]` — every 1.5 s while it is not their turn, every 5 s otherwise, not at all while the tab is hidden, and once immediately when it comes back. There are no websockets, by design: Vercel has no persistent socket host, and a poll against Redis is invisible to a human in a turn-based game.
