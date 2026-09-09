/**
 * The seat this device holds in a room (GDD §5.1, §9): a player token in
 * `localStorage`, keyed by room id, so a refresh or a reopened link resumes the
 * seat. Losing the token means losing the seat — that is the documented trade.
 *
 * `localStorage` can be unavailable (private mode, blocked cookies). Every
 * access here is guarded and answers "no storage" rather than throwing, and the
 * caller then stays a read-only visitor (§6.4) instead of claiming a seat it
 * could never resume.
 */

import { opponentOf, type Player } from '@/lib/engine';

/**
 * What is stored per room. The colour is recorded *with the game it applied to*
 * because a rematch swaps the colours attached to the two tokens (§5.4) and the
 * public room view never says which seat a token holds — see {@link colourFor}.
 */
export interface StoredSeat {
  token: string;
  colour: Player;
  /** The `gameNumber` in which this token played `colour` (§7.4). */
  gameNumber: number;
}

export function seatStorageKey(roomId: string): string {
  return `morris:seat:${roomId}`;
}

/**
 * The colour this seat plays in `gameNumber`. Each rematch increments the room's
 * `gameNumber` by one and swaps the two tokens between W and B, so the parity of
 * the difference is the whole answer.
 */
export function colourFor(seat: StoredSeat, gameNumber: number): Player {
  const swaps = Math.abs(gameNumber - seat.gameNumber) % 2;
  return swaps === 1 ? opponentOf(seat.colour) : seat.colour;
}

/** The store, or `null` when the browser will not give us one. */
function storage(): Storage | null {
  try {
    const store = globalThis.localStorage;
    if (!store) return null;
    // Safari's private mode has the object but throws on write, so probe it.
    const probe = 'morris:probe';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/** Whether a seat could be persisted at all. */
export function storageAvailable(): boolean {
  return storage() !== null;
}

function isStoredSeat(value: unknown): value is StoredSeat {
  if (typeof value !== 'object' || value === null) return false;
  const seat = value as Record<string, unknown>;
  return (
    typeof seat.token === 'string' &&
    seat.token.length > 0 &&
    (seat.colour === 'W' || seat.colour === 'B') &&
    typeof seat.gameNumber === 'number' &&
    Number.isFinite(seat.gameNumber)
  );
}

/** The seat held in this room, or `null` for none — and for anything unreadable. */
export function readSeat(roomId: string): StoredSeat | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(seatStorageKey(roomId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredSeat(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Gives the seat up. Called when the server refuses this token's authority: a
 * token the server does not recognise is worth less than no token at all, since
 * keeping it would restore the same refused seat on the next reload (§6.4).
 */
export function clearSeat(roomId: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(seatStorageKey(roomId));
  } catch {
    // Nothing to do: the seat is gone from this session either way.
  }
}

/** Persists a seat. Returns whether it will actually be there after a refresh. */
export function writeSeat(roomId: string, seat: StoredSeat): boolean {
  const store = storage();
  if (store === null) return false;
  try {
    store.setItem(seatStorageKey(roomId), JSON.stringify(seat));
    return true;
  } catch {
    return false;
  }
}
