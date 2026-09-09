# Decisions

Choices the GDD left genuinely unspecified, plus anything skipped and why. Newest last.

**Convention.** A section describes the code as it stands. When a decision is reversed, the bullet that described the old behaviour is part of the change — correct it, do not leave it standing and add a new one below. Where an append-log of passes still exists, a reversed bullet is marked inline with `*(Superseded by …)*`, and an unmarked bullet is current.

## Setup

- **Scaffolded into `./scaffold-tmp` and moved up.** `create-next-app` refuses a non-empty directory (`GDD.md`, `README.md`, `KICKOFF_PROMPT.md` were already here), which the kickoff prompt anticipated. The scaffold's own `README.md`, `AGENTS.md` and `CLAUDE.md` were discarded in favour of project-specific ones.
- **`src/` directory layout.** The GDD writes paths as `/lib/engine` and `/app/api`; with `--src-dir` these are `src/lib/engine` and `src/app/api`, reached as `@/lib/engine`. Same structure, one level down.
- **`.claude/agents` rewritten, not copied verbatim.** The agents copied from `~/development/deathmatch` describe a Godot match-3 game; carrying them over unchanged would give this project's sub-agents instructions about GDScript and sprite art. The files were replaced with a `builder` and a `critic` for this project. `.claude/settings.local.json` was copied with its Godot-binary permission stripped — a `Bash(/Applications/Godot.app/...)` allowance is meaningless in a Next.js repo — leaving only `WebSearch`. `.claude/worktrees/` (a 1.6 GB Godot worktree checkout) was not copied — it is not settings, hooks, agents or commands.
- **`@types/node` bumped to `^24`.** Vitest 5 peer-requires `^22 || >=24`; the scaffold pinned `^20`. Not a new dependency.
- **Playwright runs against a production build**, not the dev server: `webServer` runs `npm run build && npm run start -- --port 3100`. Dev-server on-demand compilation makes first-hit timings flaky, and the bar requires a clean build anyway.
- **Chromium only.** The GDD's e2e requirement is two browser contexts at two mobile viewports, not cross-browser coverage. `npx playwright install chromium`.
- **The build lives on a `build/morris` branch, not `main`.** The global rule is branch → PR → merge, and a hook enforces it. The repo has no remote and no CI, and the kickoff prompt forbids `gh auth`, so no PR can actually be opened from here — pushing the branch and opening one is the first step after the build. Each gauntlet item is one commit on that branch, named for the item, made once its critic passes it. `DECISIONS.md` is committed with each item, carrying only the sections decided by then, so a decision and the change it describes ship together. `README.md` is the exception: it documents how to run and deploy the finished app, so it lands with the deploy-readiness item and until then the repo carries the starter README it arrived with.
