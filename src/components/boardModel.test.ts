/**
 * The board's rendering decisions (GDD §6.2–6.3), tested as pure functions over
 * real engine states. `Board.tsx` is JSX over exactly these, so this is where the
 * interaction states are actually asserted — including the read-only board of
 * §6.4, which no shipped page exercises yet.
 */

import { describe, expect, it } from 'vitest';
import {
  apply,
  initialState,
  legalActions,
  removablePieces,
  type Action,
  type GameState,
} from '@/lib/engine';
import {
  boardIsActive,
  buildMarks,
  flashingMill,
  pointLabel,
} from './boardModel';

/** Applies a script of actions, always on behalf of the player to move. */
function play(script: readonly Action[]): GameState {
  return script.reduce((s, a) => apply(s, a, s.turn), initialState());
}

const place = (point: number): Action => ({ type: 'place', point });
const remove = (point: number): Action => ({ type: 'remove', point });
const move = (from: number, to: number): Action => ({ type: 'move', from, to });

/** White completes [0,1,2] and [1,9,17] with one placement (GDD §4.5). */
const DOUBLE_MILL = [0, 3, 2, 6, 9, 8, 17, 10, 1].map(place);

/**
 * Both hands empty, no mill on the board, and White can slide 3 → 2 to complete
 * [0,1,2]. Neither final piece set contains a mill, so none forms during placement.
 */
const MOVE_MILL_SCRIPT = [
  0, 5, 1, 6, 3, 7, 9, 8, 11, 10, 13, 12, 15, 14, 16, 20, 18, 23,
].map(place);

/**
 * White has just formed [20,21,22]; Black holds the mill [8,9,10] plus two loose
 * pieces at 16 and 17, so the protected-mill rule is visible on the board.
 */
const PROTECTED = [
  place(0), place(8), place(4), place(9), place(12), place(10),
  remove(0),
  place(20), place(16), place(21), place(17), place(22),
];

const MOVE_MILL = play(MOVE_MILL_SCRIPT);

function marksOf(state: GameState, selected: number | null = null) {
  return buildMarks(state, legalActions(state), selected);
}

/** Point indices whose mark has `flag` set. */
function where(
  marks: ReturnType<typeof buildMarks>,
  flag: 'hint' | 'selectable' | 'selected' | 'removable' | 'dimmed',
): number[] {
  return marks.flatMap((m, i) => (m[flag] ? [i] : []));
}

describe('boardIsActive', () => {
  const some: Action[] = [place(0)];

  it('is active only with both a handler and something legal to do', () => {
    expect(boardIsActive(some, true)).toBe(true);
  });

  it('is inert for a read-only visitor (§6.4)', () => {
    expect(boardIsActive(some, false)).toBe(false);
  });

  it('is inert when it is not your turn or the game is over (§6.2)', () => {
    expect(boardIsActive([], true)).toBe(false);
    expect(boardIsActive([], false)).toBe(false);
  });
});

describe('pointLabel (§6.5)', () => {
  it('names an empty point', () => {
    expect(pointLabel(12, null)).toBe('Point 12, empty');
  });

  it('names an occupied point by player, not by colour code', () => {
    expect(pointLabel(12, 'W')).toBe('Point 12, White piece');
    expect(pointLabel(0, 'B')).toBe('Point 0, Black piece');
  });
});

describe('buildMarks — placement phase', () => {
  it('hints every empty point on your turn (§6.2)', () => {
    const marks = marksOf(initialState());
    expect(where(marks, 'hint')).toHaveLength(24);
    expect(where(marks, 'selectable')).toEqual([]);
    expect(where(marks, 'removable')).toEqual([]);
    expect(where(marks, 'dimmed')).toEqual([]);
  });

  it('never hints an occupied point', () => {
    const state = play([place(0), place(1)]);
    const marks = marksOf(state);
    expect(where(marks, 'hint')).not.toContain(0);
    expect(where(marks, 'hint')).not.toContain(1);
    expect(where(marks, 'hint')).toHaveLength(22);
  });

  it('reports the occupants it was given', () => {
    const marks = marksOf(play([place(0), place(1)]));
    expect(marks[0].occupant).toBe('W');
    expect(marks[1].occupant).toBe('B');
    expect(marks[2].occupant).toBeNull();
  });
});

describe('buildMarks — an inert board (§6.2, §6.4)', () => {
  it('shows no hint, no selection and no removal for an empty legal list', () => {
    const state = play(PROTECTED);
    const marks = buildMarks(state, [], null);
    expect(where(marks, 'hint')).toEqual([]);
    expect(where(marks, 'selectable')).toEqual([]);
    expect(where(marks, 'selected')).toEqual([]);
    expect(where(marks, 'removable')).toEqual([]);
    expect(where(marks, 'dimmed')).toEqual([]);
  });

  it('still shows the pieces and the last move to a spectator', () => {
    const state = play(PROTECTED);
    const marks = buildMarks(state, [], null);
    expect(marks.map((m) => m.occupant)).toEqual(state.board);
    expect(where(marks, 'hint')).toEqual([]);
    expect(marks[22].lastTo).toBe(true);
  });

  it('does not dim a mid-removal board for a spectator', () => {
    const state = play(PROTECTED);
    expect(state.pendingRemoval).toBe(true);
    expect(where(buildMarks(state, [], null), 'dimmed')).toEqual([]);
  });
});

describe('buildMarks — movement phase', () => {
  // Both hands empty, so play is by sliding.
  const opening = play(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18].map(place),
  );

  it('reaches the movement phase without a removal pending', () => {
    expect(opening.phase).toBe('moving');
    expect(opening.pendingRemoval).toBe(false);
  });

  it('marks exactly the pieces that have somewhere to go', () => {
    const legal = legalActions(opening);
    const movable = new Set(
      legal.flatMap((a) => (a.type === 'move' ? [a.from] : [])),
    );
    expect(where(marksOf(opening), 'selectable')).toEqual([...movable].sort((a, b) => a - b));
  });

  it('hints nothing until a piece is selected', () => {
    expect(where(marksOf(opening), 'hint')).toEqual([]);
  });

  it('hints exactly the selected piece’s legal destinations', () => {
    const from = where(marksOf(opening), 'selectable')[0];
    const expected = legalActions(opening)
      .flatMap((a) => (a.type === 'move' && a.from === from ? [a.to] : []))
      .sort((a, b) => a - b);
    const marks = marksOf(opening, from);
    expect(expected.length).toBeGreaterThan(0);
    expect(where(marks, 'hint')).toEqual(expected);
    expect(where(marks, 'selected')).toEqual([from]);
  });

  it('ignores a selection on a point with no moves', () => {
    const stuck = [...Array(24).keys()].find(
      (i) => opening.board[i] === 'W' && !marksOf(opening)[i].selectable,
    );
    expect(stuck).toBeDefined();
    const marks = marksOf(opening, stuck ?? 0);
    expect(where(marks, 'selected')).toEqual([]);
    expect(where(marks, 'hint')).toEqual([]);
  });

  it('drops a stale selection once a removal is pending', () => {
    // Whatever was selected, removal mode offers no moves, so no ring is drawn.
    const state = play(PROTECTED);
    expect(where(marksOf(state, 20), 'selected')).toEqual([]);
  });
});

describe('buildMarks — removal mode (§6.2)', () => {
  const state = play(PROTECTED);

  it('marks removable exactly what the engine allows', () => {
    expect(state.pendingRemoval).toBe(true);
    expect(where(marksOf(state), 'removable')).toEqual(
      removablePieces(state.board, 'B').sort((a, b) => a - b),
    );
    expect(where(marksOf(state), 'removable')).toEqual([16, 17]);
  });

  it('dims the mill-protected opponent pieces and only those', () => {
    expect(where(marksOf(state), 'dimmed')).toEqual([8, 9, 10]);
  });

  it('never dims the mover’s own pieces', () => {
    for (const i of where(marksOf(state), 'dimmed')) {
      expect(state.board[i]).toBe('B');
    }
    expect(where(marksOf(state), 'dimmed')).not.toContain(22);
  });

  it('dims nothing once every opponent piece is in a mill (§4.5)', () => {
    // Black holds [8,9,10] and [1,9,17] and nothing else, so all five may be taken.
    const allInMills = play([
      place(0), place(8), place(4), place(9), place(12), place(10),
      remove(0), place(20), place(1), place(21), place(17),
      remove(4), place(22),
    ]);
    expect(allInMills.pendingRemoval).toBe(true);
    expect(where(marksOf(allInMills), 'removable')).toEqual([1, 8, 9, 10, 17]);
    expect(where(marksOf(allInMills), 'dimmed')).toEqual([]);
  });
});

describe('buildMarks — last move (§6.3)', () => {
  it('marks a placement as a destination with no origin', () => {
    const marks = marksOf(play([place(0)]));
    expect(where(marks, 'hint')).not.toContain(0);
    expect(marks[0].lastTo).toBe(true);
    expect(marks.filter((m) => m.lastFrom)).toEqual([]);
  });

  it('marks both ends of a slide', () => {
    const opening = play(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18].map(place),
    );
    const slid = apply(opening, move(16, 23), opening.turn);
    const marks = buildMarks(slid, [], null);
    expect(marks[16].lastFrom).toBe(true);
    expect(marks[23].lastTo).toBe(true);
    expect(marks[16].lastTo).toBe(false);
  });
});

describe('flashingMill (§6.3)', () => {
  it('flashes nothing before the first move', () => {
    expect(flashingMill(initialState())).toBeNull();
  });

  it('flashes nothing for a move that formed no mill', () => {
    expect(flashingMill(play([place(0), place(8)]))).toBeNull();
  });

  it('flashes the three pieces of a single mill', () => {
    const state = play([place(0), place(8), place(1), place(9), place(2)]);
    expect(flashingMill(state)?.points).toEqual([0, 1, 2]);
  });

  it('flashes all six pieces when one placement forms two mills (§4.5)', () => {
    const state = play(DOUBLE_MILL);
    expect(state.pendingRemoval).toBe(true);
    expect(flashingMill(state)?.points).toEqual([0, 1, 2, 9, 17]);
  });

  it('flashes a mill completed by a slide, not just by a placement', () => {
    const slid = apply(MOVE_MILL, move(3, 2), MOVE_MILL.turn);
    expect(flashingMill(slid)?.points).toEqual([0, 1, 2]);
    expect(flashingMill(slid)?.key).toBe('3-2-0.1.2');
  });

  it('stops flashing once the landed piece is gone', () => {
    const state = play(DOUBLE_MILL);
    const after = apply(state, remove(3), state.turn);
    // The mill still stands, so it still flashes; the key is unchanged.
    expect(flashingMill(after)?.key).toBe(flashingMill(state)?.key);
    // But a state whose last destination is now empty flashes nothing.
    const emptied: GameState = {
      ...after,
      board: after.board.map((c, i) => (i === 1 ? null : c)),
    };
    expect(flashingMill(emptied)).toBeNull();
  });

  it('keys the flash on the move and the lines, so it replays only when new', () => {
    const single = play([place(0), place(8), place(1), place(9), place(2)]);
    expect(flashingMill(single)?.key).toBe('hand-2-0.1.2');
    expect(flashingMill(play(DOUBLE_MILL))?.key).toBe('hand-1-0.1.2.9.17');
    expect(flashingMill(single)?.key).toBe(flashingMill(single)?.key);
  });
});
