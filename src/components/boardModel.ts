/**
 * Everything the board renders, as pure functions over `GameState` plus the
 * `legalActions()` list. No JSX and no rules: the only questions asked here are
 * "what is on this point" (a fact about the board) and "is this point in the
 * legal-action list I was handed". Anything that is genuinely a rule is asked of
 * the engine — see `flashingMill`, which uses `millsThrough`.
 *
 * `Board.tsx` is JSX over these; the tests in `boardModel.test.ts` are what
 * actually check the interaction states of GDD §6.2–6.3.
 */

import {
  millsThrough,
  opponentOf,
  type Action,
  type GameState,
  type Player,
} from '@/lib/engine';

export const PLAYER_NAME: Record<Player, string> = { W: 'White', B: 'Black' };

/** How one point should be drawn and announced. */
export interface Mark {
  occupant: Player | null;
  /** A legal placement, or a legal destination for the selected piece. */
  hint: boolean;
  /** An own piece with somewhere to go: tapping it selects it (§6.2). */
  selectable: boolean;
  selected: boolean;
  /** A legal removal target while a removal is pending (§6.2). */
  removable: boolean;
  /** An opponent piece the pending removal cannot take (mill-protected). */
  dimmed: boolean;
  lastFrom: boolean;
  lastTo: boolean;
}

/**
 * The board is inert with no tap handler (a read-only visitor, §6.4) or with an
 * empty legal list (not your turn, or the game is over, §6.2). One rule covers
 * all three, so no caller needs a separate flag.
 */
export function boardIsActive(
  legal: readonly Action[],
  hasTapHandler: boolean,
): boolean {
  return hasTapHandler && legal.length > 0;
}

/** GDD §6.5: "Point 12, empty" / "Point 12, White piece". */
export function pointLabel(point: number, occupant: Player | null): string {
  return `Point ${point}, ${
    occupant === null ? 'empty' : `${PLAYER_NAME[occupant]} piece`
  }`;
}

/** One `Mark` per point, in board order. */
export function buildMarks(
  state: GameState,
  legal: readonly Action[],
  selected: number | null,
): Mark[] {
  const hints = new Set<number>();
  const selectable = new Set<number>();
  const removable = new Set<number>();
  for (const a of legal) {
    if (a.type === 'place') hints.add(a.point);
    else if (a.type === 'remove') removable.add(a.point);
    else if (a.type === 'move') {
      selectable.add(a.from);
      if (a.from === selected) hints.add(a.to);
    }
  }

  // Dim only when this viewer is actually being offered a removal. A spectator
  // is handed an empty list and sees a plain board.
  const takeFrom = removable.size > 0 ? opponentOf(state.turn) : null;

  return state.board.map((occupant, i) => ({
    occupant,
    hint: hints.has(i),
    selectable: selectable.has(i),
    selected: selected === i && selectable.has(i),
    removable: removable.has(i),
    dimmed: takeFrom !== null && occupant === takeFrom && !removable.has(i),
    lastFrom: state.lastMove?.from === i,
    lastTo: state.lastMove?.to === i,
  }));
}

/** The pieces to flash, and a key that changes exactly when a new mill appears. */
export interface Flash {
  key: string;
  points: readonly number[];
}

/**
 * The mill (or mills) just completed by the last move (§6.3). The point a move
 * lands on was empty beforehand, so any mill through it is newly formed — and a
 * placement can complete two at once (§4.5), in which case all six pieces flash.
 *
 * Which lines those are is a rules question, so it is `millsThrough`'s to answer;
 * all this adds is *whose* piece landed there, which is a fact about the board.
 */
export function flashingMill(state: GameState): Flash | null {
  const last = state.lastMove;
  if (last === null) return null;

  const owner = state.board[last.to];
  if (owner === null) return null;

  const mills = millsThrough(state.board, last.to, owner);
  if (mills.length === 0) return null;

  const points = [...new Set(mills.flat())].sort((a, b) => a - b);
  return { key: `${last.from ?? 'hand'}-${last.to}-${points.join('.')}`, points };
}
