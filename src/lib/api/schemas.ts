/**
 * Zod schemas for every request body the API accepts (GDD §8.6).
 *
 * These check *shape*, not legality: an action that is structurally one of the
 * engine's five variants gets through, and the engine decides whether the rules
 * allow it. A body that fails here is a 400 and never reaches the store.
 */

import { z } from 'zod';

import { REFUSAL } from './refusals';
import { TIMER_CHOICES } from './types';

/** A player token. Never compared here — only checked for being a string. */
const token = z.string().min(1);

/**
 * `POST /api/game`. `timerMs` is optional; omitting it takes the GDD §5.3
 * default. `null` means "None", which is a choice, not a missing value.
 */
export const createGameSchema = z
  .object({ timerMs: z.union([z.int(), z.null()]).optional() })
  .refine((body) => body.timerMs === undefined || isTimerAllowed(body.timerMs), {
    message: REFUSAL.timerNotOffered,
    path: ['timerMs'],
  });

/**
 * The four timers of GDD §5.3, plus — under the e2e flag (GDD §8, bar item 3),
 * and only off Vercel — any positive timer, so the timeout-claim test does not
 * have to wait a minute for the shortest real choice.
 *
 * The flag is inert wherever Vercel is running this code. Left ungated, an
 * operator who set it on a deploy would let any client create a room with a
 * one-millisecond clock and claim a forfeit against whoever joined; §8.3
 * sanctions the flag as test-only, which is the argument for it doing nothing
 * where tests do not run.
 */
export function isTimerAllowed(timerMs: number | null): boolean {
  // "None" is a choice, not a duration, and the escape below only ever widens
  // which *numbers* count as a timer — so the choices table is the whole answer
  // for `null`, and everything after this line is about a number. Asked as a
  // conjunct at the end instead, `timerMs !== null` could never be false, which
  // read as a guard and was not one.
  if (timerMs === null) return TIMER_CHOICES.includes(null);
  if (TIMER_CHOICES.includes(timerMs)) return true;
  // Anywhere Vercel runs this code, the escape is shut — `vercel dev`, preview,
  // production and the build alike. A client request never arrives during a
  // build, so "not on Vercel at all" is the whole condition.
  if (onVercel()) return false;
  return process.env.MORRIS_E2E === '1' && timerMs > 0;
}

/**
 * Vercel sets `VERCEL=1` in every environment it runs: build, `vercel dev`,
 * preview and production. Anything else that set it would only make this gate
 * stricter, which is the safe direction for it to be wrong in.
 *
 * One variable and no carve-outs, deliberately: every exception would be a
 * second environment variable, editable in the same dashboard as the flag, that
 * turns the first one back on. `MORRIS_E2E` is compared exactly — not
 * trimmed, and not by prefix or suffix — so `MORRIS_E2E=1 `, the trailing
 * space an operator leaves in a `.env` file, leaves the escape shut. Both
 * halves fail closed, and `schemas.test.ts` pins each comparison from both
 * ends rather than against a trim alone.
 */
function onVercel(): boolean {
  return (process.env.VERCEL ?? '').trim() === '1';
}

/**
 * `POST /api/game/[id]/join`. The body is empty: the joiner has no token yet,
 * and the free seat is whichever one the room has left.
 */
export const joinSchema = z.object({});

/** `POST` to claim-timeout and rematch: the caller's token, nothing else. */
export const tokenSchema = z.object({ token });

/**
 * `POST /api/game/[id]/draw`. Both extra fields say what the tap was made
 * against, and both are optional: a body without them is judged exactly as a
 * body was before they existed.
 *
 * `gameNumber` is the game it was about — a background tab stops polling
 * (§7.3), and its "Offer draw" button can outlive the game it was drawn for.
 *
 * `accepting` is the decision the button was offering to make: `true` for
 * "accept the offer I can see", `false` for "make one". GDD §4.6 ends the game
 * only "if the other accepts", and without this the two are indistinguishable
 * on the wire — an offer landing while a tap is in flight turns that tap into
 * an acceptance of something its player never saw.
 */
export const drawSchema = z.object({
  token,
  gameNumber: z.int().nonnegative().optional(),
  accepting: z.boolean().optional(),
});

/** The engine's five `Action` variants (GDD §7.1), structurally. */
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('place'), point: z.int() }),
  z.object({ type: z.literal('move'), from: z.int(), to: z.int() }),
  z.object({ type: z.literal('remove'), point: z.int() }),
  z.object({ type: z.literal('resign') }),
  z.object({ type: z.literal('forfeit'), player: z.enum(['W', 'B']) }),
]);

/**
 * `POST /api/game/[id]/action`. `expectedVersion` is mandatory: the client says
 * which version it is acting on and the store rejects the write if the room has
 * moved on (GDD §7.3).
 */
export const actionRequestSchema = z.object({
  token,
  action: actionSchema,
  expectedVersion: z.int().nonnegative(),
});
