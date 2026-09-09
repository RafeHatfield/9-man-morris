# Kickoff prompt

Paste everything below the line into Claude Code from the new project directory (which contains only `GDD.md` and this file). Run `/init` first only if `~/development/deathmatch` doesn't have a `.claude/` directory to copy.

---

## Setup (do this first, no questions)

1. Copy `.claude/` (settings, hooks, agents, commands) and `CLAUDE.md` from `~/development/deathmatch` into this directory. Then rewrite `CLAUDE.md` so it describes *this* project: stack from `GDD.md` §3, the commands you set up (`dev`, `test`, `test:e2e`, `build`), and the rule that `GDD.md` is the source of truth.
2. `git init`, commit the starter files. Commit after every gauntlet item passes its critic review, with a message naming the item.
3. Run fully non-interactive. Pass flags for every prompt (`--yes`, explicit create-next-app options, `npx playwright install chromium`). If `create-next-app` refuses because the directory isn't empty, scaffold into `./scaffold-tmp` and move the files up. Never run `vercel login`, `vercel link`, `gh auth`, or anything else that needs my input; if a step needs it, skip it and record why in `DECISIONS.md`.
4. Read `GDD.md` in full before writing any code. Do not ask me clarifying questions — every decision you might be tempted to ask about is answered in the GDD, and §9 lists the ones that are closed. If something is genuinely unspecified, pick the simplest option consistent with the GDD, note it in `DECISIONS.md`, and keep going.

## The task (what)

Build the game described in `GDD.md`: a mobile-first web version of Nine Men's Morris on Next.js App Router, playable online by sharing a link, with local hot-seat, a per-turn timer with forfeit-on-abandon, and rematch. Deployable to Vercel on the free tier with a single Upstash Redis instance. The whole thing should be small, obvious, and boring to read — a strong engineer should be able to understand the entire codebase in twenty minutes.

## The build method (how)

Work the gauntlet: break the task into the items below, `/loop` each item, fan out sub-agents to build in parallel where items are independent, and have a **separate harsh-critic sub-agent** review every item against the GDD and the bar before it's marked done. The critic's job is to find reasons to reject. If it rejects, the builder fixes and resubmits; the critic re-reviews from scratch, not from the diff. An item is only done when the critic passes it with no findings.

Items, in dependency order:

1. **Scaffold** — Next.js + TS strict + Tailwind + Vitest + Playwright + ESLint. Scripts wired. `npm run build` clean on an empty app.
2. **Engine** — `/lib/engine` exactly per GDD §7.1. Pure, dependency-free, tested to 100% branch coverage per bar item 1. *This is the item the critic should be most brutal on: rules bugs here poison everything downstream.* The critic must independently write at least 10 adversarial rule-edge tests of its own and run them against the engine.
3. **Store** — `RoomStore` interface, `MemoryStore`, `RedisStore`, per GDD §7.2. Optimistic-concurrency `update` tested for lost-update prevention under concurrent calls.
4. **API** — all endpoints per GDD §7.3 with Zod validation. Server is sole authority; tested per bar item 2.
5. **Board UI** — SVG board component, all interaction states per GDD §6.2–6.3, driven only by `GameState` + a `legalActions` list. Must work in hot-seat mode before online is wired.
6. **Hot-seat mode** — `/local`, complete, e2e to a finished game.
7. **Online mode** — `/`, `/g/[roomId]`, join flow, polling, share panel, timer + claim, rematch, draw, resign, read-only visitors. Two-context e2e per bar item 3.
8. **Mobile pass** — run e2e at both viewports, capture screenshots, critic reviews them for the mobile bar. Fix and re-shoot until it passes.
9. **Deploy readiness** — README with setup + env vars, `vercel build` passes, `DECISIONS.md` finalised, final clean commit.

Sub-agent hygiene: builders read `GDD.md` themselves rather than relying on a summary. Critics get the GDD, the bar, and the item's output — nothing from the builder's reasoning.

## The bar (when to stop)

Stop only when **every** item in GDD §8 is met and the critic has passed all nine gauntlet items. Concretely, in the final message, show me:

- The Vitest run with the engine coverage table (branches 100%).
- The Playwright run: online two-context game to mill-out win + rematch with colour swap, hot-seat to completion, timeout claim — all green at both mobile viewports.
- The four mobile screenshots (home, mid-game with a piece selected, removal mode, game-over) at 360×740.
- `npm run build` output, zero errors, zero warnings. Run `vercel build` too only if the Vercel CLI is installed and the project is already linked; otherwise skip it and say so.
- The dependency list from `package.json`, and a one-line justification for anything outside the allowed set in GDD §8.6.
- A list of everything you did *not* do that the GDD asked for, if anything. An empty list is the goal; an honest non-empty list beats a padded claim.

Do not stop for check-ins. Do not deliver "phase one". Do not add features not in the GDD. Ultrathink on the engine and the concurrency model; everything else is straightforward. Fan out sub-agents and go.
