# Review bar for morris

## The one thing this codebase must get right
The server never accepts an illegal move and both players always see the same board. A rules bug or a lost update is the only thing that makes this game embarrassing to send to a friend.

## Hard rules
- Every rule in GDD §4 is enforced in `src/lib/engine` and nowhere else. The API and UI never re-implement a rule; they call `legalActions` / `apply`.
- No flying. A test that asserts a 3-piece player can only move to adjacent points exists and must keep passing.
- All state mutation goes through `POST /api/game/[id]/action` with `expectedVersion`. A stale version is a 409, never a silent overwrite.
- Tokens are never returned by any GET.
- No dependency outside the GDD §8.6 list without a one-line justification in `DECISIONS.md`.
- Nothing in `src/` imports React into `lib/engine` or `lib/store`.

## Reference files
- `src/lib/engine/engine.test.ts` — one test per rule clause in GDD §4, named after the clause. This is what a test file should look like here: readable as a restatement of the rules.
- `src/lib/store/store.ts` — the adapter interface and `MemoryStore`. Small, obvious, no cleverness.

## What a test has to do here
- It must fail if the production code it names is deleted or inverted. Proving that with one throwaway mutation is welcome; the mutation is never committed and never becomes a test of its own.
- It must map to a GDD clause (§4 rules, §5 modes, §7.3 API contract, §8 bar) or a concrete bug. Name it in the test title.
- It must not exist to kill a mutant, cover a branch, or complete a matrix. Coverage is an output of good tests, not a target: the GDD's 100% engine branch coverage is the only numeric gate, and it applies to the engine only.
- Proportion is a finding. If a module's tests exceed its production lines by more than 2:1, report it under does-this-need-to-exist.

## Judgeable output
The rendered board at 360×740 is output a human judges. On items that touch `src/components/board` or `src/app/g`, the reviewer takes before/after screenshots and says which is better blind, then checks against GDD §6. "Feels worse and no rule forbids it" is a SHOULD-FIX here, not a NIT. This is where over-achievement is allowed to live.

## Not in scope for review
- Naming, formatting, import order.
- Test count, test line count going *down*, or tests removed for being non-behavioural.
- Rewrites of working code that already meets the bar.
- Anything the GDD §9 lists as closed.
