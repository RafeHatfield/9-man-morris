# Morris — Nine Men's Morris

A mobile-first web Nine Men's Morris. Start a game, send the link, play online. No accounts, no lobby.

## `GDD.md` is the source of truth

`GDD.md` governs this build. If anything — a kickoff prompt, a comment, an agent's opinion, this file — disagrees with the GDD, **the GDD wins**. §9 lists decisions that are closed; do not reopen them (no flying rule, one removal per double mill, polling not websockets, `localStorage` token identity, White moves first).

Design decisions the GDD genuinely leaves open are recorded in `DECISIONS.md` with the reasoning. Add to it rather than asking.

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router), TypeScript strict, `src/` dir, `@/*` → `src/*` |
| Styling | Tailwind CSS v4 (PostCSS plugin, no config file) |
| Board | Inline SVG |
| Engine | `src/lib/engine` — pure TS, zero deps, no React imports |
| Store | `src/lib/store` — `RoomStore` interface; `MemoryStore` (dev/tests) and `RedisStore` (`@upstash/redis`) |
| Sync | Client polls `GET /api/game/[id]`. No websockets, no PartyKit, no second host |
| Validation | Zod on every API request body |
| Tests | Vitest (unit), Playwright (e2e, two browser contexts, mobile viewports) |
| Hosting | Vercel free tier + one Upstash Redis. Serverless only — no long-lived processes |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server on :3000 |
| `npm run build` | Production build. Must be clean: zero type errors, zero warnings. It does **not** lint — Next 16 dropped `next lint`, so `npm run lint` is a separate gate |
| `npm start` | Serve the production build |
| `npm test` | Vitest once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with coverage; **fails under 100% branch coverage on `src/lib/engine`** |
| `npm run test:e2e` | Builds, starts on :3100, runs Playwright at 360×740 and 390×844 |
| `npm run lint` | ESLint, `--max-warnings 0` — a warning is a failure (GDD §8.5) |
| `npm run typecheck` | `next typegen && tsc --noEmit`. The typegen step is not optional: `src/app` uses Next 16's generated `LayoutProps`/`PageProps` globals, so a bare `tsc` on a fresh checkout fails until they exist |

## Architecture rules

- **The server is the only authority.** Every mutation goes through `apply()` server-side. The client sends an intent plus `expectedVersion` and adopts whatever the server returns. It never trusts its own optimistic state.
- **The engine is pure.** No I/O, no clock, no randomness, no React. `apply()` returns a new `GameState` or throws. Time and identity live in the `Room`, not the game.
- **Single source of truth.** The board topology (adjacency, the 16 mill lines) is defined once, in the engine, and imported everywhere else — the UI never re-declares point coordinates' meaning, only their pixel positions.
- **The UI is driven by `GameState` + `legalActions(state)`.** No rules logic in components. If a component needs to know whether a tap is legal, it asks the engine.
- **Type safety is a feature.** No `any`, no non-null assertions where a narrow is possible.
- **Boring is the goal.** A strong engineer should understand the whole codebase in twenty minutes. Minimum complexity for the current task; three similar lines beat a premature abstraction.
- **No dependency** beyond Next, React, Tailwind, `@upstash/redis`, Vitest, Playwright and Zod (GDD §8.6). Anything else needs a one-line justification in the commit message.

## Workflow

- Semantic commit messages (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`).
- Commit after each gauntlet item passes critic review, naming the item.
- Never claim green without pasting the run.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
