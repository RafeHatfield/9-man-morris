/**
 * Who is playing which colour in hot-seat (GDD §5.2: "Rematch swaps colours").
 *
 * Online there are two seats, each holding a token, and a rematch swaps the
 * colours attached to them (§5.4, §7.4 `gameNumber`). On one device there are no
 * tokens — but there are still two people, so the same thing is true: the swap
 * is a swap of *who plays which colour*, not of anything about the board. White
 * still moves first in every game (§4.2, §9), so a colour swap is only visible
 * if the two people are named, which is what `Seat` is for.
 *
 * `gameNumber` is 1-based and increments on each rematch, exactly as in §7.4,
 * and its parity decides who is White.
 */

import type { Player } from '@/lib/engine';

/** The two people at the device. Not a colour — the colour is derived. */
export type Seat = 'P1' | 'P2';

export const SEATS: readonly Seat[] = ['P1', 'P2'];

export const SEAT_NAME: Record<Seat, string> = {
  P1: 'Player 1',
  P2: 'Player 2',
};

/** The colour `seat` plays in game `gameNumber` (1 = the first game). */
export function colourOf(seat: Seat, gameNumber: number): Player {
  const p1IsWhite = gameNumber % 2 === 1;
  return (seat === 'P1') === p1IsWhite ? 'W' : 'B';
}

/** The seat playing `player` in game `gameNumber` — the inverse of `colourOf`. */
export function seatOf(player: Player, gameNumber: number): Seat {
  return colourOf('P1', gameNumber) === player ? 'P1' : 'P2';
}
