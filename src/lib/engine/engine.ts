/**
 * The rules of Nine Men's Morris (GDD §4), as pure functions over an immutable
 * `GameState`. No I/O, no clock, no randomness, no React. `apply` returns a new
 * state or throws; it never mutates its input.
 */

import { ADJACENCY, LINES_THROUGH, POINT_COUNT } from './board';
import type { Action, Cell, GameState, Player, Result } from './types';

/** GDD §4.2: nine pieces each, all starting in hand. */
const PIECES_PER_PLAYER = 9;

/** Movement-phase moves without a removal that end the game in a draw (GDD §4.6). */
export const DRAW_MOVE_LIMIT = 50;

/** Thrown by `apply` for any action the rules do not allow. */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}

/**
 * The single definition of "finished", used by `legalActions`, `apply`,
 * `agreeDraw` and `endTurn`. `finish` always sets `result` and `phase` together,
 * so within the engine either field would do — but a state that reaches us with
 * only one of them set (from a store, say) must not be live for one function and
 * over for another, so both count.
 */
function isOver(s: GameState): boolean {
  return s.result !== null || s.phase === 'over';
}

/**
 * Every state the engine hands out is deep-frozen, so "immutable `GameState`"
 * (GDD §7.1) is enforced rather than promised — and so no returned state shares
 * mutable storage with the one it came from, which would make a caller's write
 * reach backwards into a state it does not own.
 */
function seal(s: GameState): GameState {
  return frozen({
    ...s,
    board: frozen([...s.board]),
    hand: frozen({ ...s.hand }),
    lastMove: s.lastMove === null ? null : frozen({ ...s.lastMove }),
    result: s.result === null ? null : frozen({ ...s.result }),
  });
}

function frozen<T>(value: T): T {
  return Object.freeze(value);
}

export function opponentOf(player: Player): Player {
  return player === 'W' ? 'B' : 'W';
}

export function initialState(): GameState {
  return seal({
    board: Array<Cell>(POINT_COUNT).fill(null),
    hand: { W: PIECES_PER_PLAYER, B: PIECES_PER_PLAYER },
    turn: 'W',
    phase: 'placing',
    pendingRemoval: false,
    movesSinceRemoval: 0,
    lastMove: null,
    result: null,
  });
}

/**
 * The mill lines `player` holds through `point` — none, one, or both of the two
 * lines that cross there (GDD §4.5 contemplates a move completing two). The piece
 * must already be on the board: this is asked after a placement or move, not
 * before it. Throws `IllegalActionError` for a point that is not on the board.
 *
 * The UI uses this to flash the pieces of a mill that has just formed (§6.3), so
 * that the "which line is a mill" question stays here and not in a component.
 */
export function millsThrough(
  board: Cell[],
  point: number,
  player: Player,
): readonly (readonly [number, number, number])[] {
  requirePoint(point);
  return LINES_THROUGH[point].filter((mill) =>
    mill.every((i) => board[i] === player),
  );
}

/** True when `point` is part of a mill for `player`. See {@link millsThrough}. */
export function formsMill(board: Cell[], point: number, player: Player): boolean {
  return millsThrough(board, point, player).length > 0;
}

/**
 * The opponent pieces that may legally be taken (GDD §4.5): those outside a mill,
 * or every one of them when they are all in mills.
 */
export function removablePieces(board: Cell[], opponent: Player): number[] {
  const all: number[] = [];
  const unprotected: number[] = [];
  for (let i = 0; i < POINT_COUNT; i++) {
    if (board[i] !== opponent) continue;
    all.push(i);
    if (!formsMill(board, i, opponent)) unprotected.push(i);
  }
  return unprotected.length > 0 ? unprotected : all;
}

/**
 * The board actions available to the player to move — what the UI offers on a tap.
 *
 * `resign` and `forfeit` are deliberately absent: either player may resign at any
 * time, whoever's turn it is, and a forfeit is issued by the server against the
 * player on the clock. Both are validated in `apply`.
 */
export function legalActions(s: GameState): Action[] {
  if (isOver(s) || unplayable(s) !== null) return [];

  if (s.pendingRemoval) {
    return removablePieces(s.board, opponentOf(s.turn)).map((point) => ({
      type: 'remove',
      point,
    }));
  }

  const actions: Action[] = [];
  if (s.phase === 'placing') {
    for (let point = 0; point < POINT_COUNT; point++) {
      if (s.board[point] === null) actions.push({ type: 'place', point });
    }
    return actions;
  }

  for (let from = 0; from < POINT_COUNT; from++) {
    if (s.board[from] !== s.turn) continue;
    for (const to of ADJACENCY[from]) {
      if (s.board[to] === null) actions.push({ type: 'move', from, to });
    }
  }
  return actions;
}

/**
 * The reason a board action cannot be taken on this state, or `null` if none of
 * the three shapes below applies. Each would corrupt the rules rather than merely
 * end the game: a board that is not the board, a debt that can never be paid, and
 * a mover placing from a hand that cannot be placed from.
 *
 * What is guaranteed is that no state **reachable from `initialState()`** is one
 * of these — the engine is closed over the games it can actually play. It is not
 * closed over states someone hands it: a placing position with unequal hands is
 * accepted here, and playing it out strands the shorter-handed player, which is
 * why that shape is refused rather than assumed away.
 *
 * A state can be stuck for reasons this does not name — a walled-in mover in the
 * movement phase, a full board with pieces still in hand — and those are left
 * alone: `legalActions` returns `[]`, the three exits still work, and nothing is
 * miscounted. It says nothing about whether the *position* is reachable either: a
 * board of 24 White pieces passes here and is an impossible game. Legality is
 * `apply`'s business, one action at a time.
 */
function unplayable(s: GameState): string | null {
  if (s.board.length !== POINT_COUNT) {
    return `a board has ${POINT_COUNT} points, not ${s.board.length}`;
  }
  if (s.pendingRemoval && removablePieces(s.board, opponentOf(s.turn)).length === 0) {
    return 'a removal is pending with nothing to remove';
  }
  // A mover with an empty hand still has a removal to make if a mill just formed,
  // and the phase flips only once the turn passes — so this is stuck only when
  // nothing is owed. A hand that is not a positive whole number is refused for the
  // same reason `applyPlace` no longer checks it: placing never lands such a hand
  // on exactly zero, and the phase flip only ever tests for exactly zero. (Not
  // that placing moves it away from zero — 2.5 counts down through 0.5 and
  // straight past — so clamping, or a `>= 0` test, would not be this guard.)
  const inHand = s.hand[s.turn];
  if (
    !s.pendingRemoval &&
    s.phase === 'placing' &&
    !(Number.isInteger(inHand) && inHand > 0)
  ) {
    return `${s.turn} has nothing left to place`;
  }
  return null;
}

/**
 * Guards the three board actions. Resignation, forfeit and an agreed draw are
 * deliberately *not* guarded: they are how a game ends, and a stuck room is
 * exactly the room that needs them — refusing them there would turn a room with
 * three exits into a room with none.
 */
function requireBoardAction(s: GameState): void {
  const problem = unplayable(s);
  if (problem !== null) throw new IllegalActionError(problem);
}

/** Applies `action` on behalf of `by`. Returns a new state; throws if illegal. */
export function apply(s: GameState, action: Action, by: Player): GameState {
  if (isOver(s)) throw new IllegalActionError('the game is over');

  switch (action.type) {
    case 'place':
      requireBoardAction(s);
      return seal(applyPlace(s, action.point, by));
    case 'move':
      requireBoardAction(s);
      return seal(applyMove(s, action.from, action.to, by));
    case 'remove':
      requireBoardAction(s);
      return seal(applyRemove(s, action.point, by));
    case 'resign':
      return seal(finish(s, { winner: opponentOf(by), reason: 'resign' }));
    case 'forfeit':
      return seal(applyForfeit(s, action.player, by));
    default:
      throw new IllegalActionError(
        `unknown action: ${JSON.stringify(action satisfies never)}`,
      );
  }
}

/** Both players agreed a draw (GDD §4.6). Offer and acceptance live in the room. */
export function agreeDraw(s: GameState): GameState {
  if (isOver(s)) throw new IllegalActionError('the game is over');
  return seal(finish(s, { winner: null, reason: 'drawagreed' }));
}

// — internals —————————————————————————————————————————————————————————

function applyPlace(s: GameState, point: number, by: Player): GameState {
  requireTurn(s, by);
  if (s.phase !== 'placing')
    throw new IllegalActionError('not the placement phase');
  if (s.pendingRemoval) throw new IllegalActionError('a removal is pending');
  requirePoint(point);
  if (s.board[point] !== null)
    throw new IllegalActionError(`point ${point} is occupied`);
  // No hand check here: `requireBoardAction` has already refused a placing state
  // whose mover has an empty hand, and that is the only way to reach one.

  const board = [...s.board];
  board[point] = by;
  const hand = { ...s.hand };
  hand[by] -= 1;

  return afterMove(
    { ...s, board, hand, lastMove: { from: null, to: point } },
    point,
    by,
  );
}

function applyMove(
  s: GameState,
  from: number,
  to: number,
  by: Player,
): GameState {
  requireTurn(s, by);
  if (s.phase !== 'moving') throw new IllegalActionError('not the moving phase');
  if (s.pendingRemoval) throw new IllegalActionError('a removal is pending');
  requirePoint(from);
  requirePoint(to);
  if (s.board[from] !== by)
    throw new IllegalActionError(`point ${from} is not your piece`);
  if (s.board[to] !== null)
    throw new IllegalActionError(`point ${to} is occupied`);
  if (!ADJACENCY[from].includes(to))
    throw new IllegalActionError(`point ${to} is not adjacent to ${from}`);

  const board = [...s.board];
  board[from] = null;
  board[to] = by;

  return afterMove(
    {
      ...s,
      board,
      lastMove: { from, to },
      movesSinceRemoval: s.movesSinceRemoval + 1,
    },
    to,
    by,
  );
}

function applyRemove(s: GameState, point: number, by: Player): GameState {
  requireTurn(s, by);
  if (!s.pendingRemoval) throw new IllegalActionError('no removal is pending');
  requirePoint(point);

  const foe = opponentOf(by);
  if (s.board[point] !== foe)
    throw new IllegalActionError(`point ${point} is not an opponent piece`);
  if (!removablePieces(s.board, foe).includes(point))
    throw new IllegalActionError(`point ${point} is protected by a mill`);

  const board = [...s.board];
  board[point] = null;

  return endTurn({ ...s, board, movesSinceRemoval: 0 });
}

function applyForfeit(s: GameState, player: Player, by: Player): GameState {
  if (player !== s.turn)
    throw new IllegalActionError('only the player on the clock can forfeit');
  if (by === player)
    throw new IllegalActionError('a forfeit is claimed by the opponent');
  return finish(s, { winner: opponentOf(player), reason: 'forfeit' });
}

/** Shared tail of a placement or move: take the removal, or pass the turn. */
function afterMove(s: GameState, point: number, by: Player): GameState {
  const mill = formsMill(s.board, point, by);
  // A mill with nothing left to take (the opponent has no pieces on the board)
  // would deadlock the turn, so it simply passes.
  if (mill && removablePieces(s.board, opponentOf(by)).length > 0) {
    return { ...s, pendingRemoval: true };
  }
  return endTurn(s);
}

function endTurn(s: GameState): GameState {
  const next: GameState = {
    ...s,
    turn: opponentOf(s.turn),
    pendingRemoval: false,
  };
  // Placement ends when both hands are empty (GDD §4.3) — hand count, not move count.
  if (next.phase === 'placing' && next.hand.W === 0 && next.hand.B === 0) {
    next.phase = 'moving';
  }

  // A decisive result beats the 50-move draw: a move that both walls the
  // opponent in and completes the fiftieth move is a win, not a draw. See
  // DECISIONS.md.
  const started = startTurn(next);
  if (isOver(started)) return started;

  // "50 consecutive moves in the movement phase" (GDD §4.6) — the counter only
  // rises there, but a state from a store need not agree, so say it outright.
  if (next.phase === 'moving' && next.movesSinceRemoval >= DRAW_MOVE_LIMIT) {
    return finish(next, { winner: null, reason: 'draw50' });
  }
  return started;
}

/** The two losing conditions, checked at the start of the mover's turn (GDD §4.6). */
function startTurn(s: GameState): GameState {
  const me = s.turn;
  if (pieceCount(s, me) < 3) {
    return finish(s, { winner: opponentOf(me), reason: 'millout' });
  }
  if (s.phase === 'moving' && legalActions(s).length === 0) {
    return finish(s, { winner: opponentOf(me), reason: 'blocked' });
  }
  return s;
}

/**
 * Reached only from `endTurn`, so `requireBoardAction` has already established
 * that the board is `POINT_COUNT` points: the bound and `s.board.length` are the
 * same number here, and bounding by the constant says which one is meant.
 */
function pieceCount(s: GameState, player: Player): number {
  let onBoard = 0;
  for (let i = 0; i < POINT_COUNT; i++) if (s.board[i] === player) onBoard++;
  return s.hand[player] + onBoard;
}

function finish(s: GameState, result: Result): GameState {
  return { ...s, phase: 'over', pendingRemoval: false, result };
}

function requireTurn(s: GameState, by: Player): void {
  if (by !== s.turn) throw new IllegalActionError(`it is not ${by}'s turn`);
}

function requirePoint(point: number): void {
  if (!Number.isInteger(point) || point < 0 || point >= POINT_COUNT) {
    throw new IllegalActionError(`point ${point} is not on the board`);
  }
}
