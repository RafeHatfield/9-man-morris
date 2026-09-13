/**
 * The room a client is holding, and the one rule about replacing it (GDD §7.3).
 *
 * Split out of `useRoom` so the rule can be tested: it is the thing that stops a
 * poll that overtook a mutation from re-drawing the board as it was before the
 * tap that changed it.
 */

import type { PublicRoom } from '@/lib/api/types';

export type RoomStatus = 'loading' | 'ready' | 'missing';

export interface RoomState {
  room: PublicRoom | null;
  status: RoomStatus;
  /** `serverNow - Date.now()` at the last response: the client clock's error. */
  skewMs: number;
}

export const INITIAL_ROOM_STATE: RoomState = {
  room: null,
  status: 'loading',
  skewMs: 0,
};

/**
 * Take the server's word for it, unless this is an older word than we have.
 *
 * A room's `version` only ever climbs, so a response carrying a lower one is a
 * read that was already in flight when a newer answer arrived. An equal version
 * is adopted: it is the same board, and its `serverNow` re-measures the clock.
 *
 * @param at the client clock when the response arrived, for the skew.
 */
export function adoptRoom(
  prev: RoomState,
  next: PublicRoom,
  at: number,
): RoomState {
  if (prev.room !== null && next.version < prev.room.version) return prev;
  return { room: next, status: 'ready', skewMs: next.serverNow - at };
}

/**
 * The room is not there (a 404 on the read).
 *
 * `status` is what the page renders from — a missing room shows the room-is-gone
 * screen, whether or not this client already had a board — and it is also what
 * stops the polling. The last room is kept because there is no reason to throw
 * it away, not because anything still draws it.
 */
export function roomMissing(prev: RoomState): RoomState {
  return prev.status === 'missing' ? prev : { ...prev, status: 'missing' };
}
