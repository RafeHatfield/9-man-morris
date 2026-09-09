# Morris — starter directory

Files:
- `GDD.md` — game design doc, source of truth for the build
- `KICKOFF_PROMPT.md` — paste into Claude Code to start the gauntlet

## Before kicking off (2 minutes)

1. `mkdir ~/development/morris && cd ~/development/morris`, drop `GDD.md` and `KICKOFF_PROMPT.md` in.
2. Confirm `~/development/deathmatch/.claude/` exists (the prompt copies it). If not, run `/init` in Claude Code first.
3. Nothing else. Local dev and every test run on the in-memory store, so no cloud resources are needed for the build itself.

## After the build (5 minutes)

1. Push to GitHub, import into Vercel.
2. In the Vercel project: Storage → Marketplace → Upstash Redis → create (free). Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically; the generated README will name whichever env vars the code reads.
3. Redeploy. Open the URL on your phone, tap New game, text the link to someone.
