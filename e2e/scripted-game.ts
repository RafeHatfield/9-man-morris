/**
 * A scripted game that ends in a White mill-out win (GDD §4.6), as a list of
 * engine actions to be tapped out through the UI.
 *
 * It is a fixed literal on purpose: the e2e is judged on what the *page* does,
 * so the expected outcome has to come from somewhere other than the engine the
 * page is using. The sequence was found by self-play against the engine and then
 * frozen; if the rules ever change under it, the spec's final assertions fail,
 * which is the point.
 *
 * White forms three mills during placement and then shuttles a piece in and out
 * of 21–22–23 in the movement phase, taking one Black piece each time, until
 * Black is down to two (§4.6, "fewer than 3 pieces"). Black never forms a mill,
 * so White never loses a piece. Black always has a legal move, so the game ends
 * on the piece count and not by blocking.
 */

import type { Action } from '../src/lib/engine';

/**
 * The opening, ending on White's mill at 5–13–21 with the removal still to play:
 * after this the board is in removal mode (§6.2) and point 20 is takeable.
 */
export const OPENING: readonly Action[] = [
  { type: 'place', point: 5 }, // W
  { type: 'place', point: 19 }, // B
  { type: 'place', point: 22 }, // W
  { type: 'place', point: 20 }, // B
  { type: 'place', point: 8 }, // W
  { type: 'place', point: 1 }, // B
  { type: 'place', point: 21 }, // W
  { type: 'place', point: 3 }, // B
  { type: 'place', point: 13 }, // W — mill 5–13–21
];

/** The first removal offered by that mill. */
export const FIRST_REMOVAL = 20;

/** The rest of the game: two more placement mills, then the endgame shuttle. */
export const REST: readonly Action[] = [
  { type: 'remove', point: 20 }, // W takes
  { type: 'place', point: 12 }, // B
  { type: 'place', point: 20 }, // W — mill 20–21–22
  { type: 'remove', point: 3 }, // W takes
  { type: 'place', point: 11 }, // B
  { type: 'place', point: 7 }, // W
  { type: 'place', point: 6 }, // B
  { type: 'place', point: 15 }, // W
  { type: 'place', point: 9 }, // B
  { type: 'place', point: 14 }, // W — mill 8–15–14
  { type: 'remove', point: 19 }, // W takes; White's hand is now empty
  { type: 'place', point: 18 }, // B — last piece, movement phase begins
  { type: 'move', from: 22, to: 23 }, // W — mill 7–15–23
  { type: 'remove', point: 9 }, // W takes
  { type: 'move', from: 11, to: 19 }, // B
  { type: 'move', from: 23, to: 22 }, // W — re-forms 20–21–22
  { type: 'remove', point: 19 }, // W takes
  { type: 'move', from: 12, to: 11 }, // B
  { type: 'move', from: 22, to: 23 }, // W — re-forms 7–15–23
  { type: 'remove', point: 6 }, // W takes
  { type: 'move', from: 18, to: 17 }, // B
  { type: 'move', from: 23, to: 22 }, // W — re-forms 20–21–22
  { type: 'remove', point: 17 }, // W takes: Black is down to two pieces
];

/** The whole game, in order. */
export const MILL_OUT_GAME: readonly Action[] = [...OPENING, ...REST];
