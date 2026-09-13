/**
 * How often the client re-reads the room (GDD §7.3).
 *
 * "Every 1.5 s while the game is live and it is *not* the client's turn; every
 * 5 s otherwise; stops when the tab is hidden and resumes on focus." A room that
 * is not there is not polled at all.
 */

export const POLL_ACTIVE_MS = 1_500;
export const POLL_IDLE_MS = 5_000;

export interface PollConditions {
  /** The tab is in the background (`visibilitychange`). */
  hidden: boolean;
  /** The room 404s: there is nothing to poll for. */
  missing: boolean;
  /** The game has not finished. */
  live: boolean;
  /** This client is the player to move, so nothing can change without it. */
  yourTurn: boolean;
}

/** The poll interval in ms, or `null` for "do not poll". */
export function pollIntervalMs({
  hidden,
  missing,
  live,
  yourTurn,
}: PollConditions): number | null {
  if (hidden || missing) return null;
  return live && !yourTurn ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}
