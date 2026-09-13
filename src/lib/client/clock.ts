/**
 * The per-turn clock, as the client draws it (GDD §5.3).
 *
 * The clock is server-authoritative: the room carries `turnStartedAt`, `timerMs`
 * and the server's own `serverNow`, and the client only subtracts. Every
 * function here is pure — the current time is an argument, never `Date.now()`.
 */

/** Below this, the countdown goes red (GDD §5.3). */
export const URGENT_MS = 10_000;

/**
 * How far past zero the clock must be before the client offers **Claim win**.
 *
 * The server awards a forfeit only once the elapsed time is strictly greater
 * than the timer, judged by its own clock. The client's estimate of that clock
 * can run a little ahead (it is corrected only at each poll), so a button
 * offered at exactly zero can be refused. Half a second of margin means the
 * button appears when the claim will actually be honoured.
 */
export const CLAIM_GRACE_MS = 500;

/** The server's clock, as this client best estimates it. */
export function serverNow(clientNow: number, skewMs: number): number {
  return clientNow + skewMs;
}

/**
 * How much of the active player's turn is left. Negative once it has run out —
 * the caller decides what that means, since there is no auto-forfeit (§5.3).
 */
export function remainingMs(
  turnStartedAt: number,
  timerMs: number,
  now: number,
): number {
  return turnStartedAt + timerMs - now;
}

/** GDD §5.3: the opponent may claim the win once the clock has run out. */
export function canClaim(remaining: number): boolean {
  return remaining <= -CLAIM_GRACE_MS;
}

export function isUrgent(remaining: number): boolean {
  return remaining < URGENT_MS;
}

/** `M:SS`, or `H:MM:SS` from an hour up. Never negative: a spent clock is 0:00. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

const TIMER_LABELS = new Map<number | null, string>([
  [null, 'None'],
  [60_000, '1 min'],
  [300_000, '5 min'],
  [86_400_000, '1 day'],
]);

/** The four choices of GDD §5.3 by name; anything else falls back to a clock. */
export function timerLabel(timerMs: number | null): string {
  return TIMER_LABELS.get(timerMs) ?? formatClock(timerMs ?? 0);
}
