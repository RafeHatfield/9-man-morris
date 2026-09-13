import { describe, expect, it } from 'vitest';
import { POINT_COUNT } from './board';
import {
  DRAW_MOVE_LIMIT,
  IllegalActionError,
  agreeDraw,
  apply,
  formsMill,
  initialState,
  legalActions,
  millsThrough,
  opponentOf,
  removablePieces,
} from './engine';
import type { Action, Cell, GameState, Player } from './types';

/** 24 cells as `W`, `B` or `.`, whitespace ignored. */
function boardOf(spec: string): Cell[] {
  const cells = [...spec.replace(/\s/g, '')];
  expect(cells).toHaveLength(POINT_COUNT);
  return cells.map((c) => (c === 'W' ? 'W' : c === 'B' ? 'B' : null));
}

function state(patch: Partial<GameState>): GameState {
  return { ...initialState(), ...patch };
}

/** A movement-phase position; hands are empty. */
function moving(spec: string, patch: Partial<GameState> = {}): GameState {
  return state({
    board: boardOf(spec),
    hand: { W: 0, B: 0 },
    phase: 'moving',
    ...patch,
  });
}

function play(s: GameState, script: [Player, Action][]): GameState {
  return script.reduce((acc, [by, action]) => apply(acc, action, by), s);
}

const place = (point: number): Action => ({ type: 'place', point });
const remove = (point: number): Action => ({ type: 'remove', point });
const move = (from: number, to: number): Action => ({ type: 'move', from, to });

describe('initialState', () => {
  it('starts with 24 empty points, nine in each hand and White to place', () => {
    const s = initialState();
    expect(s.board).toHaveLength(POINT_COUNT);
    expect(s.board.every((c) => c === null)).toBe(true);
    expect(s.hand).toEqual({ W: 9, B: 9 });
    expect(s.turn).toBe('W');
    expect(s.phase).toBe('placing');
    expect(s.pendingRemoval).toBe(false);
    expect(s.movesSinceRemoval).toBe(0);
    expect(s.lastMove).toBeNull();
    expect(s.result).toBeNull();
  });

  it('returns a fresh state each time', () => {
    const a = initialState();
    const b = initialState();
    expect(a).not.toBe(b);
    expect(a.board).not.toBe(b.board);
    expect(a.hand).not.toBe(b.hand);
    expect(a).toEqual(b);
  });
});

describe('opponentOf', () => {
  it('swaps the players', () => {
    expect(opponentOf('W')).toBe('B');
    expect(opponentOf('B')).toBe('W');
  });
});

describe('removablePieces', () => {
  it('offers only the pieces outside a mill', () => {
    const board = boardOf('BBB..B.. ........ ........');
    expect(removablePieces(board, 'B')).toEqual([5]);
  });

  it('offers every piece when they are all in mills (GDD §4.5)', () => {
    const board = boardOf('BBB..... BBB..... ........');
    expect(removablePieces(board, 'B')).toEqual([0, 1, 2, 8, 9, 10]);
  });

  it('offers nothing when the opponent has no pieces on the board', () => {
    expect(removablePieces(boardOf('WWW..... ........ ........'), 'B')).toEqual([]);
  });
});

describe('legalActions', () => {
  it('offers every empty point while placing', () => {
    const s = state({ board: boardOf('WB...... ........ ........') });
    expect(legalActions(s)).toHaveLength(22);
    expect(legalActions(s)).toContainEqual(place(2));
    expect(legalActions(s)).not.toContainEqual(place(0));
  });

  it('offers slides to adjacent empty points only', () => {
    const s = moving('W.B..... ........ ........');
    expect(legalActions(s)).toEqual([move(0, 1), move(0, 7)]);
  });

  it('offers the removable opponent pieces while a removal is pending', () => {
    const s = moving('WWW..... BBB..B.. ........', { pendingRemoval: true });
    expect(legalActions(s)).toEqual([remove(13)]);
  });

  it('offers nothing once the game is over', () => {
    const s = state({ phase: 'over', result: { winner: 'W', reason: 'resign' } });
    expect(legalActions(s)).toEqual([]);
  });
});

describe('placement (GDD §4.3)', () => {
  it('places a piece, spends it from the hand and passes the turn', () => {
    const s = apply(initialState(), place(4), 'W');
    expect(s.board[4]).toBe('W');
    expect(s.hand).toEqual({ W: 8, B: 9 });
    expect(s.turn).toBe('B');
    expect(s.lastMove).toEqual({ from: null, to: 4 });
    expect(s.phase).toBe('placing');
  });

  it('does not mutate the state it was given', () => {
    const before = initialState();
    const snapshot = JSON.stringify(before);
    apply(before, place(4), 'W');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('holds the turn for a removal when the placement makes a mill', () => {
    const s = state({
      board: boardOf('WW...... B....... ........'),
      hand: { W: 7, B: 8 },
    });
    const next = apply(s, place(2), 'W');
    expect(next.pendingRemoval).toBe(true);
    expect(next.turn).toBe('W');
    expect(legalActions(next)).toEqual([remove(8)]);
  });

  it('passes the turn when a mill has nothing to take', () => {
    const s = state({
      board: boardOf('WW...... ........ ........'),
      hand: { W: 1, B: 0 },
    });
    const next = apply(s, place(2), 'W');
    expect(next.pendingRemoval).toBe(false);
    // Black has no pieces at all, so Black loses on entering their turn.
    expect(next.result).toEqual({ winner: 'W', reason: 'millout' });
  });

  it('rejects placing out of turn, off-board, on a taken point, or with an empty hand', () => {
    const s = initialState();
    expect(() => apply(s, place(0), 'B')).toThrow(IllegalActionError);
    expect(() => apply(s, place(-1), 'W')).toThrow(/not on the board/);
    expect(() => apply(s, place(POINT_COUNT), 'W')).toThrow(/not on the board/);
    expect(() => apply(s, place(1.5), 'W')).toThrow(/not on the board/);
    expect(() => apply(apply(s, place(0), 'W'), place(0), 'B')).toThrow(/occupied/);
    // A placing mover with nothing to place is not reachable from `initialState()`,
    // so it is refused as unplayable before the placement itself is judged.
    expect(() => apply(state({ hand: { W: 0, B: 9 } }), place(0), 'W')).toThrow(
      /W has nothing left to place/,
    );
  });

  it('rejects placing in the moving phase, or while a removal is pending', () => {
    expect(() => apply(moving('........ ........ ........'), place(0), 'W')).toThrow(
      /not the placement phase/,
    );
    const pending = state({
      board: boardOf('WWW..... B....... ........'),
      hand: { W: 6, B: 8 },
      pendingRemoval: true,
    });
    expect(() => apply(pending, place(3), 'W')).toThrow(/removal is pending/);
  });
});

describe('movement (GDD §4.4)', () => {
  it('slides a piece to an adjacent empty point', () => {
    const s = moving('W.WW.... .B.BB... ........');
    const next = apply(s, move(0, 1), 'W');
    expect(next.board[0]).toBeNull();
    expect(next.board[1]).toBe('W');
    expect(next.lastMove).toEqual({ from: 0, to: 1 });
    expect(next.turn).toBe('B');
    expect(next.movesSinceRemoval).toBe(1);
  });

  it('rejects moving out of turn, off-board, a piece that is not yours, onto a taken point, or a jump', () => {
    const s = moving('W.WW.... .B.BB... ........');
    expect(() => apply(s, move(0, 1), 'B')).toThrow(/not B's turn/);
    expect(() => apply(s, move(-1, 1), 'W')).toThrow(/not on the board/);
    expect(() => apply(s, move(0, POINT_COUNT), 'W')).toThrow(/not on the board/);
    expect(() => apply(s, move(1, 0), 'W')).toThrow(/is not your piece/);
    expect(() => apply(s, move(9, 8), 'W')).toThrow(/is not your piece/);
    expect(() => apply(s, move(2, 3), 'W')).toThrow(/occupied/);
    expect(() => apply(s, move(0, 5), 'W')).toThrow(/not adjacent/);
  });

  it('rejects moving in the placement phase, or while a removal is pending', () => {
    expect(() => apply(initialState(), move(0, 1), 'W')).toThrow(/not the moving phase/);
    const pending = moving('WWW..... BBB..B.. ........', { pendingRemoval: true });
    expect(() => apply(pending, move(0, 7), 'W')).toThrow(/removal is pending/);
  });

  it('counts a mill re-formed by moving out and back (GDD §4.5)', () => {
    const s = moving('WWW..... .B.BB.B. ........');
    const out = apply(s, move(2, 3), 'W');
    expect(out.pendingRemoval).toBe(false);
    const back = apply(apply(out, move(14, 13), 'B'), move(3, 2), 'W');
    expect(formsMill(back.board, 2, 'W')).toBe(true);
    expect(back.pendingRemoval).toBe(true);
  });
});

describe('removal (GDD §4.5)', () => {
  const pending = () =>
    moving('WWW..... BBB..B.. ........', { pendingRemoval: true });

  it('takes an unprotected piece and passes the turn', () => {
    const next = apply(pending(), remove(13), 'W');
    expect(next.board[13]).toBeNull();
    expect(next.pendingRemoval).toBe(false);
    expect(next.turn).toBe('B');
  });

  it('refuses a piece protected by a mill while a loose piece exists', () => {
    expect(() => apply(pending(), remove(8), 'W')).toThrow(/protected by a mill/);
  });

  it('allows a piece in a mill once every opponent piece is in one', () => {
    const s = moving('WWW.W... BBB..... ........', { pendingRemoval: true });
    expect(removablePieces(s.board, 'B')).toEqual([8, 9, 10]);
    expect(apply(s, remove(9), 'W').board[9]).toBeNull();
  });

  it('yields exactly one removal for a double mill (GDD §4.5, §9)', () => {
    // Placing at 9 completes both 8-9-10 and 1-9-17 for White.
    const s = state({
      board: boardOf('.W..BB.. W.W..... .W..B...'),
      hand: { W: 5, B: 5 },
    });
    const milled = apply(s, place(9), 'W');
    expect(milled.pendingRemoval).toBe(true);
    const after = apply(milled, remove(4), 'W');
    expect(after.pendingRemoval).toBe(false);
    expect(after.turn).toBe('B');
  });

  it('rejects removing out of turn, with none pending, off-board, or of the wrong piece', () => {
    expect(() => apply(pending(), remove(13), 'B')).toThrow(/not B's turn/);
    expect(() => apply(moving('WWW..... BBB..B.. ........'), remove(13), 'W')).toThrow(
      /no removal is pending/,
    );
    expect(() => apply(pending(), remove(POINT_COUNT), 'W')).toThrow(/not on the board/);
    expect(() => apply(pending(), remove(0), 'W')).toThrow(/not an opponent piece/);
    expect(() => apply(pending(), remove(4), 'W')).toThrow(/not an opponent piece/);
  });
});

describe('phase transition (GDD §4.3)', () => {
  it('switches to moving only when both hands are empty, after mills and removals', () => {
    // A scripted game: White mills on plies 5, 13, 15 and 17; Black on plies 10 and 16.
    const script: [Player, Action][] = [
      ['W', place(0)],
      ['B', place(8)],
      ['W', place(1)],
      ['B', place(9)],
      ['W', place(2)],
      ['W', remove(8)], // White's mill 0-1-2
      ['B', place(10)],
      ['W', place(4)],
      ['B', place(11)],
      ['W', place(6)],
      ['B', place(12)],
      ['B', remove(6)], // Black's mill 10-11-12
      ['W', place(6)],
      ['B', place(13)],
      ['W', place(7)],
      ['W', remove(13)], // White's mill 6-7-0
      ['B', place(14)],
      ['W', place(5)],
      ['W', remove(14)], // White's mill 4-5-6
      ['B', place(8)],
      ['B', remove(1)], // Black's mill 8-9-10; every White piece is in a mill
      ['W', place(1)],
      ['W', remove(8)], // White re-forms 0-1-2; every Black piece is in a mill
      ['B', place(13)],
    ];

    let s = initialState();
    let lastPlaced = -1;
    for (const [by, action] of script) {
      s = apply(s, action, by);
      const placementsLeft = s.hand.W + s.hand.B;
      // The phase flips on the last placement (ply 24 of the script), not before.
      expect(s.phase).toBe(placementsLeft === 0 ? 'moving' : 'placing');
      // A placement records itself; a removal leaves the placement that earned it
      // standing, so the highlight still shows the move that made the mill.
      if (action.type === 'place') {
        expect(s.lastMove).toEqual({ from: null, to: action.point });
        lastPlaced = action.point;
      } else {
        expect(s.lastMove).toEqual({ from: null, to: lastPlaced });
      }
    }

    expect(s.hand).toEqual({ W: 0, B: 0 });
    expect(s.phase).toBe('moving');
    expect(s.turn).toBe('W');
    expect(s.board.filter((c) => c === 'W')).toHaveLength(7);
    expect(s.board.filter((c) => c === 'B')).toHaveLength(5);
    expect(s.movesSinceRemoval).toBe(0);
    expect(s.result).toBeNull();
  });

  it('does not count placements toward the draw counter', () => {
    const s = play(initialState(), [
      ['W', place(0)],
      ['B', place(8)],
      ['W', place(4)],
      ['B', place(12)],
    ]);
    expect(s.movesSinceRemoval).toBe(0);
  });
});

describe('losing (GDD §4.6)', () => {
  it('loses on falling below three pieces', () => {
    const s = moving('WWW..W.. BB.B.... ........', { pendingRemoval: true });
    const after = apply(s, remove(11), 'W');
    expect(after.result).toEqual({ winner: 'W', reason: 'millout' });
    expect(after.phase).toBe('over');
  });

  it('counts pieces still in hand toward the three', () => {
    const s = state({
      board: boardOf('WWW..W.. BB.B.... ........'),
      hand: { W: 0, B: 1 },
      pendingRemoval: true,
    });
    const after = apply(s, remove(9), 'W');
    // Black is left with two on the board and one in hand — still three, not lost.
    expect(after.result).toBeNull();
    expect(after.turn).toBe('B');
  });

  it('declares a block when the player to move is walled in', () => {
    // Black holds 0-1-2; White at 3 and 7 seals every exit once 10 slides to 9.
    const s = moving('BBBW...W ..W..... ........', { turn: 'W' });
    const after = apply(s, move(10, 9), 'W');
    expect(after.result).toEqual({ winner: 'W', reason: 'blocked' });
    expect(after.phase).toBe('over');
  });

  it('cannot be blocked while pieces remain in hand', () => {
    // The blocked test is guarded on the movement phase (GDD §4.6). That guard can
    // never fire during placement: 18 pieces at most on 24 points, so an empty
    // point — and therefore a legal placement — always exists.
    const s = state({
      board: boardOf('BBBW..W. ........ ........'),
      hand: { W: 5, B: 5 },
      turn: 'W',
    });
    expect(apply(s, place(9), 'W').result).toBeNull();

    // The fullest board a mover can face while still holding a piece: seventeen
    // placed, one in hand, and seven points still free to put it on.
    const fullest = state({
      board: boardOf('WBWBWBWB WBWBWBWB W.......'),
      hand: { W: 0, B: 1 },
      turn: 'B',
    });
    expect(fullest.board.filter((c) => c !== null)).toHaveLength(17);
    expect(legalActions(fullest)).toHaveLength(7);
    expect(apply(fullest, place(20), 'B').result).toBeNull();
  });
});

describe('the 50-move draw (GDD §4.6)', () => {
  it('draws on the fiftieth movement-phase move without a removal', () => {
    const s = moving('W.WW.... .B.BB... ........', {
      movesSinceRemoval: DRAW_MOVE_LIMIT - 1,
    });
    const after = apply(s, move(0, 1), 'W');
    expect(after.movesSinceRemoval).toBe(DRAW_MOVE_LIMIT);
    expect(after.result).toEqual({ winner: null, reason: 'draw50' });
    expect(after.phase).toBe('over');
  });

  it('does not draw one move short', () => {
    const s = moving('W.WW.... .B.BB... ........', {
      movesSinceRemoval: DRAW_MOVE_LIMIT - 2,
    });
    expect(apply(s, move(0, 1), 'W').result).toBeNull();
  });

  it('resets the counter on a removal (GDD §8.1)', () => {
    const s = moving('WW.W.... BBB..B.. ........', {
      movesSinceRemoval: DRAW_MOVE_LIMIT - 1,
    });
    const milled = apply(s, move(3, 2), 'W');
    expect(milled.pendingRemoval).toBe(true);
    expect(milled.result).toBeNull();
    const after = apply(milled, remove(13), 'W');
    expect(after.movesSinceRemoval).toBe(0);
    expect(after.result).toBeNull();
  });
});

describe('resignation, forfeit and agreed draws', () => {
  it('hands the win to the opponent on resignation, whoever is to move', () => {
    expect(apply(initialState(), { type: 'resign' }, 'W').result).toEqual({
      winner: 'B',
      reason: 'resign',
    });
    expect(apply(initialState(), { type: 'resign' }, 'B').result).toEqual({
      winner: 'W',
      reason: 'resign',
    });
  });

  it('forfeits the player on the clock, at the opponent’s claim', () => {
    const s = initialState();
    expect(apply(s, { type: 'forfeit', player: 'W' }, 'B').result).toEqual({
      winner: 'B',
      reason: 'forfeit',
    });
    expect(() => apply(s, { type: 'forfeit', player: 'B' }, 'W')).toThrow(
      /on the clock/,
    );
    expect(() => apply(s, { type: 'forfeit', player: 'W' }, 'W')).toThrow(
      /claimed by the opponent/,
    );
  });

  it('agrees a draw', () => {
    const drawn = agreeDraw(initialState());
    expect(drawn.result).toEqual({ winner: null, reason: 'drawagreed' });
    expect(drawn.phase).toBe('over');
    expect(() => agreeDraw(drawn)).toThrow(/game is over/);
  });

  it('clears a pending removal when the game ends', () => {
    const s = moving('WWW..... BBB..B.. ........', { pendingRemoval: true });
    expect(apply(s, { type: 'resign' }, 'W').pendingRemoval).toBe(false);
  });
});

describe('a finished game accepts nothing', () => {
  const over = state({
    phase: 'over',
    result: { winner: 'W', reason: 'resign' },
    board: boardOf('WWW..... BBB..B.. ........'),
    hand: { W: 0, B: 0 },
  });

  it.each<Action>([
    place(4),
    move(0, 7),
    remove(13),
    { type: 'resign' },
    { type: 'forfeit', player: 'W' },
  ])('rejects %o', (action) => {
    expect(() => apply(over, action, 'W')).toThrow(/the game is over/);
  });

});

describe('an action of a type the engine does not have', () => {
  it('is refused on a live game, where every real action would be allowed', () => {
    const bogus = { type: 'teleport', point: 3 } as unknown as Action;
    expect(legalActions(initialState())).toHaveLength(24);
    expect(() => apply(initialState(), bogus, 'W')).toThrow(IllegalActionError);
  });
});

describe('millsThrough', () => {
  const boardWith = (spec: string): Cell[] => boardOf(spec);

  it('returns nothing when the point is in no mill', () => {
    expect(millsThrough(boardWith('WW...... ........ ........'), 0, 'W')).toEqual([]);
  });

  it('returns the one line a piece completes', () => {
    expect(millsThrough(boardWith('WWW..... ........ ........'), 1, 'W')).toEqual([
      [0, 1, 2],
    ]);
  });

  it('returns both lines of a double mill (GDD §4.5)', () => {
    // Point 9 sits on the middle ring's top line and on the top spoke.
    const board = boardWith('.W...... WWW..... .W......');
    expect(millsThrough(board, 9, 'W')).toEqual([
      [8, 9, 10],
      [1, 9, 17],
    ]);
    expect(formsMill(board, 9, 'W')).toBe(true);
  });

  it('answers for the player asked, not the piece that is there', () => {
    expect(millsThrough(boardWith('WWW..... ........ ........'), 1, 'B')).toEqual([]);
  });

  it('rejects a point that is not on the board', () => {
    expect(() => millsThrough(boardWith('........ ........ ........'), 24, 'W')).toThrow(
      IllegalActionError,
    );
  });
});

describe('edges no single suite covers on its own', () => {
  it('loses on hand+board falling below three during the placement phase', () => {
    const s = state({
      board: boardOf('WWWWWWWW B....... ........'),
      hand: { W: 1, B: 2 },
      turn: 'W',
      phase: 'placing',
      pendingRemoval: true,
    });
    const after = apply(s, remove(8), 'W');
    // Black holds nothing on the board and two in hand: two pieces, so it is over
    // even though the placement phase has not run out.
    expect(after.result).toEqual({ winner: 'W', reason: 'millout' });
    expect(after.phase).toBe('over');
  });

  it('handles a removal that ends the placement phase and declares a block at once', () => {
    const s = state({
      board: boardOf('WWWB...B B.B..... ....W...'),
      hand: { W: 0, B: 1 },
      turn: 'B',
      phase: 'placing',
    });
    const milled = apply(s, place(9), 'B');
    expect(milled.phase).toBe('placing');
    expect(milled.pendingRemoval).toBe(true);
    expect(milled.hand).toEqual({ W: 0, B: 0 });

    // The removal empties both hands into the movement phase and walls White in
    // on the same step.
    expect(apply(milled, remove(20), 'B').result).toEqual({
      winner: 'B',
      reason: 'blocked',
    });
  });

  it('never writes through a deeply frozen state, on any path', () => {
    const freeze = (s: GameState): GameState => {
      Object.freeze(s.board);
      Object.freeze(s.hand);
      if (s.lastMove) Object.freeze(s.lastMove);
      if (s.result) Object.freeze(s.result);
      return Object.freeze(s);
    };

    // Legal paths: place, mill, remove, slide, resign, forfeit, agreed draw.
    const start = freeze(initialState());
    const placed = freeze(apply(start, place(0), 'W'));
    const milled = freeze(
      play(placed, [
        ['B', place(8)],
        ['W', place(1)],
        ['B', place(9)],
        ['W', place(2)],
      ]),
    );
    expect(milled.pendingRemoval).toBe(true);
    freeze(apply(milled, remove(8), 'W'));
    freeze(apply(start, { type: 'resign' }, 'W'));
    freeze(apply(start, { type: 'forfeit', player: 'W' }, 'B'));
    freeze(agreeDraw(start));
    const slid = freeze(moving('W.WW.... .B.BB... ........'));
    freeze(apply(slid, move(0, 1), 'W'));

    // Throwing paths must not have written anything either.
    for (const [s, action, by] of [
      [start, place(0), 'B'],
      [placed, place(0), 'B'],
      [start, move(0, 1), 'W'],
      [milled, place(3), 'W'],
      [milled, remove(0), 'W'],
      [slid, move(0, 5), 'W'],
      [start, { type: 'forfeit', player: 'B' } as Action, 'W'],
    ] as [GameState, Action, Player][]) {
      expect(() => apply(s, action, by)).toThrow(IllegalActionError);
    }
  });
});

describe('the states the engine hands out are immutable (GDD §7.1)', () => {
  const written = (write: () => void): boolean => {
    try {
      write();
      return true;
    } catch {
      return false;
    }
  };

  it('freezes the state, the board, the hand, the last move and the result', () => {
    const s = apply(initialState(), place(0), 'W');
    expect(written(() => (s.turn = 'W'))).toBe(false);
    expect(written(() => (s.board[5] = 'B'))).toBe(false);
    expect(written(() => (s.hand.W = 0))).toBe(false);
    expect(written(() => s.board.push(null))).toBe(false);
    expect(s.lastMove).not.toBeNull();
    expect(written(() => (s.lastMove!.to = 9))).toBe(false);

    const over = apply(s, { type: 'resign' }, 'B');
    expect(over.result).not.toBeNull();
    expect(written(() => (over.result!.reason = 'draw50'))).toBe(false);
  });

  it('shares no mutable storage with the state it was given, on any path', () => {
    const placed = apply(initialState(), place(0), 'W');
    const moving_ = moving('W.WW.... .B.BB... ........');
    const pending = moving('WWW..... BBB..B.. ........', { pendingRemoval: true });

    const pairs: [GameState, GameState][] = [
      [initialState(), placed],
      [moving_, apply(moving_, move(0, 1), 'W')],
      [pending, apply(pending, remove(13), 'W')],
      [moving_, apply(moving_, { type: 'resign' }, 'W')],
      [moving_, apply(moving_, { type: 'forfeit', player: 'W' }, 'B')],
      [moving_, agreeDraw(moving_)],
    ];
    for (const [before, after] of pairs) {
      expect(after.board).not.toBe(before.board);
      expect(after.hand).not.toBe(before.hand);
      if (after.lastMove !== null) expect(after.lastMove).not.toBe(before.lastMove);
    }
  });

  it('does not freeze the state it was given', () => {
    // Sealing the output must not reach backwards into an input the caller owns.
    const mine = state({ board: boardOf('W....... ........ ........') });
    apply(mine, place(1), 'W');
    expect(Object.isFrozen(mine)).toBe(false);
    expect(Object.isFrozen(mine.board)).toBe(false);
  });
});

describe('a state that is over by either field', () => {
  it('makes legalActions and apply agree on a half-set state', () => {
    for (const half of [
      // A board with slides available, so an empty action list can only come
      // from the guard and not from there being nothing to do.
      state({
        phase: 'over',
        board: boardOf('W.WW.... .B.BB... ........'),
        hand: { W: 0, B: 0 },
      }),
      state({
        result: { winner: 'W', reason: 'resign' },
        board: boardOf('W.WW.... .B.BB... ........'),
        hand: { W: 0, B: 0 },
        phase: 'moving',
      }),
    ]) {
      expect(legalActions(half)).toEqual([]);
      expect(() => apply(half, place(4), 'W')).toThrow(/the game is over/);
      expect(() => agreeDraw(half)).toThrow(/the game is over/);
    }
  });
});

describe('the §4.6 clauses, at their boundaries', () => {
  it('loses on being walled in with exactly three pieces', () => {
    const s = moving('BBBW...W ..W..... ........', { turn: 'W' });
    expect(s.board.filter((c) => c === 'B')).toHaveLength(3);
    expect(apply(s, move(10, 9), 'W').result).toEqual({
      winner: 'W',
      reason: 'blocked',
    });
  });

  it('loses on exactly two pieces, even with a legal move available', () => {
    // Three Black pieces, one taken: exactly two left, and both can still move.
    const s = moving('WWW..W.. BB.B.... ........', { pendingRemoval: true });
    const after = apply(s, remove(11), 'W');
    expect(after.board.filter((c) => c === 'B')).toHaveLength(2);
    expect(legalActions({ ...after, result: null, phase: 'moving', turn: 'B' }))
      .not.toHaveLength(0);
    expect(after.result).toEqual({ winner: 'W', reason: 'millout' });
  });

  it('defers a block when the last placement walls in the placer', () => {
    // Black's ninth piece goes to 16, which is sealed — but it is White's turn,
    // so the loss is only declared when Black's own turn comes round.
    const s = state({
      board: boardOf('BBBW...W .W...W.. .W.....W'),
      hand: { W: 0, B: 1 },
      turn: 'B',
    });
    const placed = apply(s, place(16), 'B');
    expect(placed.phase).toBe('moving');
    expect(placed.turn).toBe('W');
    expect(placed.result).toBeNull();
    expect(legalActions({ ...placed, turn: 'B' })).toEqual([]);

    // White plays somewhere that does not open a door for Black.
    expect(apply(placed, move(13, 12), 'W').result).toEqual({
      winner: 'W',
      reason: 'blocked',
    });
  });
});

describe('states the engine refuses to be handed (not ones it produces)', () => {
  // These are shapes `initialState()` can never reach; a caller can still build
  // one, and the three exits still work on it, so a stuck room is never a sealed
  // room. What is refused is playing on.
  it('refuses a board that is not 24 points', () => {
    const short = state({ board: boardOf('W.WW.... .B.BB... ........').slice(0, 23) });
    const long = state({
      board: [...boardOf('W.WW.... .B.BB... ........'), 'W'] as Cell[],
    });
    for (const bad of [short, long]) {
      expect(() => apply(bad, place(5), 'W')).toThrow(/24 points/);
      expect(legalActions(bad)).toEqual([]);
      // The ways out of a game are not board actions, so they still work.
      expect(agreeDraw(bad).result).toEqual({ winner: null, reason: 'drawagreed' });
      expect(apply(bad, { type: 'resign' }, 'W').result).toEqual({
        winner: 'B',
        reason: 'resign',
      });
    }
  });

  it('refuses an over-long board rather than counting its phantom pieces', () => {
    // Two White pieces on the board, a phantom third beyond it: White has lost.
    const s = state({
      board: [...boardOf('W...W... ..BBB... ........'), 'W'] as Cell[],
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'B',
    });
    expect(() => apply(s, move(10, 9), 'B')).toThrow(/24 points/);
    const trimmed = state({ ...s, board: s.board.slice(0, 24) });
    expect(apply(trimmed, move(10, 9), 'B').result).toEqual({
      winner: 'B',
      reason: 'millout',
    });
  });

  it('refuses to place from a hand that is not a positive whole number', () => {
    // `applyPlace` no longer checks the hand itself, so this is the only thing
    // standing between a corrupt hand and a game that places its way past zero.
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      const s = state({ hand: { W: bad, B: 9 } });
      expect(() => apply(s, place(0), 'W')).toThrow(/W has nothing left to place/);
      expect(legalActions(s)).toEqual([]);
    }
    // A positive whole hand is fine, and the turn still passes normally.
    expect(apply(state({ hand: { W: 1, B: 9 } }), place(0), 'W').hand.W).toBe(0);
  });

  it('refuses a board action when a pending removal could never be discharged', () => {
    // Black holds nothing on the board, so the owed removal has no target and
    // the game would sit there with no legal action for either player.
    const stuck = state({
      board: boardOf('WWW..... ........ ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      pendingRemoval: true,
    });
    expect(legalActions(stuck)).toEqual([]);
    expect(() => apply(stuck, remove(0), 'W')).toThrow(/nothing to remove/);
    // But the room is not sealed shut: a stuck game is exactly the game that
    // needs its exits, so resignation, forfeit and an agreed draw still work.
    expect(apply(stuck, { type: 'resign' }, 'W').result).toEqual({
      winner: 'B',
      reason: 'resign',
    });
    expect(apply(stuck, { type: 'forfeit', player: 'W' }, 'B').result).toEqual({
      winner: 'B',
      reason: 'forfeit',
    });
    expect(agreeDraw(stuck).result).toEqual({ winner: null, reason: 'drawagreed' });
  });

  it('accepts a pending removal that can be discharged', () => {
    const fine = moving('WWW..... BBB..B.. ........', { pendingRemoval: true });
    expect(apply(fine, remove(13), 'W').pendingRemoval).toBe(false);
  });

  it('keeps the 50-move draw to the movement phase (GDD §4.6)', () => {
    const placing = state({
      board: boardOf('W....... B....... ........'),
      hand: { W: 5, B: 5 },
      movesSinceRemoval: DRAW_MOVE_LIMIT,
    });
    expect(apply(placing, place(4), 'W').result).toBeNull();
  });
});

describe('the constants the GDD fixes by value', () => {
  it('draws after fifty movement-phase moves, not some other number', () => {
    // GDD §4.6 states the number. Every other test refers to it symbolically, so
    // without this the constant could be edited to anything and stay green.
    expect(DRAW_MOVE_LIMIT).toBe(50);

    const shuttling = moving('W.W.W... B.B.B... ........');
    let s = shuttling;
    const legs: [number, number][] = [
      [4, 5],
      [12, 13],
      [5, 4],
      [13, 12],
    ];
    for (let ply = 0; ply < 49; ply++) {
      const [from, to] = legs[ply % legs.length];
      s = apply(s, move(from, to), s.turn);
      expect(s.result).toBeNull();
    }
    const [from, to] = legs[49 % legs.length];
    expect(apply(s, move(from, to), s.turn).result).toEqual({
      winner: null,
      reason: 'draw50',
    });
  });

  it('starts each player with nine pieces in hand (GDD §4.2)', () => {
    expect(initialState().hand).toEqual({ W: 9, B: 9 });
  });
});

describe('the draw counter past its limit', () => {
  it('still draws on a state that arrives already past fifty', () => {
    // `>=`, not `===`: a state from a store could carry a counter beyond the
    // limit, and an equality test would let that game run forever without ever
    // being able to draw.
    const s = moving('W.WW.... .B.BB... ........', {
      movesSinceRemoval: DRAW_MOVE_LIMIT + 10,
    });
    expect(apply(s, move(0, 1), 'W').result).toEqual({
      winner: null,
      reason: 'draw50',
    });
  });
});
