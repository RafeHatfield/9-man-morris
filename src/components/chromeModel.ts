/**
 * The text and numbers in the chrome (GDD §6.1), as pure functions.
 * `StatusBar.tsx` and `BottomBar.tsx` are JSX over these.
 */

import { opponentOf, type GameState, type Player, type Reason } from '@/lib/engine';
import { PLAYER_NAME } from './boardModel';

const REASON_TEXT: Record<Reason, string> = {
  millout: 'mill-out',
  blocked: 'blocked',
  forfeit: 'forfeit',
  resign: 'resignation',
  draw50: '50-move rule',
  drawagreed: 'agreed',
};

const PHASE_TEXT = {
  placing: 'Placement',
  moving: 'Movement',
  over: 'Game over',
} as const;

/**
 * The headline, as this viewer should read it.
 *
 * @param you     the viewer's colour, or null/undefined for hot-seat and
 *                spectators, where there is no "your turn" to speak of.
 * @param waiting  the room has no opponent yet, so nobody may move. GDD §6.2
 *                 pairs an inert board with a status bar that says why, and
 *                 "Your turn" over a board that refuses every tap is the one
 *                 thing it must not say.
 */
export function statusHeadline(
  state: GameState,
  you?: Player | null,
  waiting = false,
): string {
  if (state.result !== null) {
    const { winner, reason } = state.result;
    return winner === null
      ? `Draw — ${REASON_TEXT[reason]}`
      : `${PLAYER_NAME[winner]} wins — ${REASON_TEXT[reason]}`;
  }
  if (waiting) return 'Waiting for an opponent…';
  if (you === undefined || you === null) {
    return `${PLAYER_NAME[state.turn]} to play`;
  }
  return you === state.turn
    ? 'Your turn'
    : `Waiting for ${PLAYER_NAME[state.turn]}…`;
}

/** The second line: the pending-removal prompt, else the phase. */
export function statusDetail(state: GameState, spectating = false): string {
  const base =
    state.pendingRemoval && state.result === null
      ? `Mill! ${PLAYER_NAME[state.turn]} removes a ${
          PLAYER_NAME[opponentOf(state.turn)]
        } piece.`
      : PHASE_TEXT[state.phase];
  return spectating ? `${base} · Spectating` : base;
}

/** Pieces in hand and on the board for one side (§6.1). */
export function pieceCounts(
  state: GameState,
  player: Player,
): { hand: number; onBoard: number } {
  return {
    hand: state.hand[player],
    onBoard: state.board.reduce((n, c) => (c === player ? n + 1 : n), 0),
  };
}
