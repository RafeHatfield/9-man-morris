/**
 * A second adversarial suite, written independently of `rules.test.ts` by a
 * later critic and kept. Its load-bearing cases are the independent re-derivation
 * of the board tables from the GDD §4.1 picture (A1/A2) — one of the two checks
 * that would catch a table edited to match a wrong test, `reference.test.ts` K0
 * being the other — and the freezing and
 * `legalActions`/`apply` agreement cases the shipped suites reach only by
 * accident (A3, A5, A16). The numbering skips A14 and A15: both were dropped once
 * `board.test.ts` and `engine.test.ts` came to cover the same ground, and the
 * remaining labels are left as they were so a finding against one still lands.
 */
import { describe, expect, it } from 'vitest';
import { ADJACENCY, MILLS, POINTS, POINT_COUNT } from './board';
import {
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

function boardOf(spec: string): Cell[] {
  const cells = [...spec.replace(/\s/g, '')];
  expect(cells).toHaveLength(POINT_COUNT);
  return cells.map((c) => (c === 'W' ? 'W' : c === 'B' ? 'B' : null));
}
function state(patch: Partial<GameState>): GameState {
  return { ...initialState(), ...patch };
}
const place = (point: number): Action => ({ type: 'place', point });
const remove = (point: number): Action => ({ type: 'remove', point });
const move = (from: number, to: number): Action => ({ type: 'move', from, to });

function deepFrozen(s: GameState): boolean {
  return (
    Object.isFrozen(s) &&
    Object.isFrozen(s.board) &&
    Object.isFrozen(s.hand) &&
    (s.lastMove === null || Object.isFrozen(s.lastMove)) &&
    (s.result === null || Object.isFrozen(s.result))
  );
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── An independent derivation of the tables from the GDD §4.1 ASCII picture ──
// Coordinates read straight off the diagram on a 7x7 grid: the three rings sit
// at inset 0, 1 and 2, and the centre (3,3) is not a point.
const XY: readonly (readonly [number, number])[] = [
  [0, 0], [3, 0], [6, 0], [6, 3], [6, 6], [3, 6], [0, 6], [0, 3], // outer 0–7
  [1, 1], [3, 1], [5, 1], [5, 3], [5, 5], [3, 5], [1, 5], [1, 3], // middle 8–15
  [2, 2], [3, 2], [4, 2], [4, 3], [4, 4], [3, 4], [2, 4], [2, 3], // inner 16–23
];

/**
 * Collinear triples read off the picture. A row or column of the diagram holds
 * either three points (one line) or six (the two halves of a spoke row, split by
 * the empty centre).
 */
function derivedLines(): number[][] {
  const lines: number[][] = [];
  for (const axis of [0, 1] as const) {
    for (let v = 0; v <= 6; v++) {
      const on = POINTS.filter((p) => XY[p][axis] === v).sort(
        (a, b) => XY[a][1 - axis] - XY[b][1 - axis],
      );
      // Every row and column of the picture holds 0, 3 or 6 points — 6 on the
      // two lines through the middle, which are two mills with the empty centre
      // between them. Asserted rather than assumed, because the split below is
      // only right if that is the whole set.
      expect([0, 3, 6]).toContain(on.length);
      if (on.length === 3) lines.push(on);
      if (on.length === 6) lines.push(on.slice(0, 3), on.slice(3));
    }
  }
  return lines;
}

describe('A1: the tables re-derived from the GDD §4.1 diagram, independently', () => {
  const lines = derivedLines();

  it('produces exactly the 16 mill lines the engine ships', () => {
    expect(lines).toHaveLength(16);
    const norm = (m: readonly number[]) =>
      [...m].sort((a, b) => a - b).join(',');
    expect(new Set(lines.map(norm))).toEqual(new Set(MILLS.map(norm)));
  });

  it('produces exactly the adjacency the engine ships', () => {
    const adj: number[][] = POINTS.map(() => []);
    for (const [a, b, c] of lines) {
      adj[a].push(b);
      adj[b].push(a, c);
      adj[c].push(b);
    }
    for (const p of POINTS) {
      expect([...new Set(adj[p])].sort((x, y) => x - y)).toEqual(
        [...ADJACENCY[p]].sort((x, y) => x - y),
      );
    }
  });
});

describe('A2: an independent reference agrees on every rules query', () => {
  const refMills = derivedLines();
  const refFormsMill = (board: Cell[], p: number, who: Player) =>
    refMills.some((m) => m.includes(p) && m.every((q) => board[q] === who));
  const refRemovable = (board: Cell[], foe: Player) => {
    const mine = POINTS.filter((p) => board[p] === foe);
    const loose = mine.filter((p) => !refFormsMill(board, p, foe));
    return loose.length > 0 ? loose : mine;
  };

  it('matches formsMill and removablePieces on 10000 random positions', () => {
    const rnd = mulberry32(20250908);
    for (let n = 0; n < 10000; n++) {
      const board = Array<Cell>(POINT_COUNT).fill(null);
      const count = 3 + Math.floor(rnd() * 16);
      for (let i = 0; i < count; i++) {
        board[Math.floor(rnd() * POINT_COUNT)] = rnd() < 0.5 ? 'W' : 'B';
      }
      for (const who of ['W', 'B'] as const) {
        for (const p of POINTS) {
          expect(formsMill(board, p, who)).toBe(refFormsMill(board, p, who));
        }
        expect(removablePieces(board, who)).toEqual(refRemovable(board, who));
      }
    }
  }, 60_000);
});

describe('A3: every state the engine hands out is deep-frozen', () => {
  it('freezes initialState itself, not just the states apply returns', () => {
    expect(deepFrozen(initialState())).toBe(true);
  });

  it('freezes every state of a full random game, on every path', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(seed);
      let s = initialState();
      for (let ply = 0; ply < 400 && s.result === null; ply++) {
        const options = legalActions(s);
        s = apply(s, options[Math.floor(rnd() * options.length)], s.turn);
        expect(deepFrozen(s)).toBe(true);
      }
      expect(deepFrozen(s)).toBe(true);
    }
  }, 60_000);

  it('freezes the terminal states of resign, forfeit and agreed draw', () => {
    const live = state({
      board: boardOf('WWW..... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      pendingRemoval: true,
    });
    expect(deepFrozen(apply(live, { type: 'resign' }, 'B'))).toBe(true);
    expect(deepFrozen(apply(live, { type: 'forfeit', player: 'W' }, 'B'))).toBe(
      true,
    );
    expect(deepFrozen(agreeDraw(live))).toBe(true);
  });

  it('cannot be written through to anything the engine still holds', () => {
    const s = apply(initialState(), place(0), 'W');
    expect(() => {
      (s as { turn: Player }).turn = 'B';
    }).toThrow(TypeError);
    expect(() => {
      s.board[1] = 'B';
    }).toThrow(TypeError);
    expect(() => {
      s.hand.W = 99;
    }).toThrow(TypeError);
    expect(initialState().board.every((c) => c === null)).toBe(true);
    expect(ADJACENCY[0]).toEqual([1, 7]);
  });
});

describe('A4: freezing does not break what the rest of the app does', () => {
  it('survives a JSON round trip, structuredClone and spreading', () => {
    const s = apply(apply(initialState(), place(0), 'W'), place(8), 'B');
    const viaJson = JSON.parse(JSON.stringify(s)) as GameState;
    expect(viaJson).toEqual(s);
    expect(Object.isFrozen(viaJson)).toBe(false);
    const cloned = structuredClone(s);
    expect(cloned).toEqual(s);
    expect(Object.isFrozen(cloned)).toBe(false);
    cloned.board[3] = 'W';
    const spread: GameState = { ...s, turn: 'W' };
    expect(Object.isFrozen(spread)).toBe(false);
    // A shallow spread still shares the frozen board — a half-frozen object.
    expect(spread.board).toBe(s.board);
    expect(apply(viaJson, place(1), 'W').board[1]).toBe('W');
  });
});

describe('A5: legalActions must not offer what apply refuses', () => {
  it('agrees with apply on EVERY state of many random games, not a sample', () => {
    const universe: Action[] = [];
    for (const p of POINTS) {
      universe.push(place(p), remove(p));
      for (const q of ADJACENCY[p]) universe.push(move(p, q));
    }
    const key = (a: Action) => JSON.stringify(a);
    for (let seed = 101; seed <= 108; seed++) {
      const rnd = mulberry32(seed);
      let s = initialState();
      for (let ply = 0; ply < 400 && s.result === null; ply++) {
        const offered = legalActions(s);
        const offeredKeys = new Set(offered.map(key));
        for (const a of universe) {
          if (offeredKeys.has(key(a))) {
            expect(() => apply(s, a, s.turn)).not.toThrow();
          } else {
            expect(() => apply(s, a, s.turn)).toThrow(IllegalActionError);
            expect(() => apply(s, a, opponentOf(s.turn))).toThrow(
              IllegalActionError,
            );
          }
        }
        s = apply(s, offered[Math.floor(rnd() * offered.length)], s.turn);
      }
    }
  }, 120_000);

  it('offers nothing on a placing state whose mover has an empty hand', () => {
    // Not reachable from `initialState()`, but reachable from a store or a
    // state, or by playing out one that already had unequal hands — the same class
    // of half-set state that `isOver` was widened for.
    const half = state({
      board: boardOf('WWWWWWWW WBBBBBBB B.......'),
      hand: { W: 0, B: 1 },
      turn: 'W',
      phase: 'placing',
    });
    expect(legalActions(half)).toEqual([]);
    // The other seat, which does still hold a piece, is offered the empty points.
    expect(legalActions({ ...half, turn: 'B' }).length).toBeGreaterThan(0);
  });
});

describe('A6: a standing mill grants nothing on an unrelated move', () => {
  it('does not re-arm a removal for a mill that was already there', () => {
    const s = state({
      board: boardOf('WWW..W.. ...B.BB. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
    });
    expect(formsMill(s.board, 1, 'W')).toBe(true);
    const after = apply(s, move(5, 4), 'W');
    expect(after.pendingRemoval).toBe(false);
    expect(after.turn).toBe('B');
    expect(formsMill(after.board, 1, 'W')).toBe(true);
  });

  it('grants exactly one removal for leaving one mill to complete another', () => {
    // White holds 0-1-2 and 8, 10. Sliding 1→9 breaks 0-1-2 and completes
    // 8-9-10 in the same ply: one mill formed, one removal.
    const s = state({
      board: boardOf('WWW..... W.W.BB.. ....B.B.'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
    });
    expect(formsMill(s.board, 0, 'W')).toBe(true);
    const after = apply(s, move(1, 9), 'W');
    expect(millsThrough(after.board, 9, 'W')).toEqual([[8, 9, 10]]);
    expect(formsMill(after.board, 0, 'W')).toBe(false);
    expect(after.pendingRemoval).toBe(true);
    expect(after.turn).toBe('W');

    const taken = apply(after, remove(12), 'W');
    expect(taken.pendingRemoval).toBe(false);
    expect(taken.turn).toBe('B');
    expect(taken.result).toBeNull();

    // Sliding back re-forms 0-1-2 and grants a fresh removal (GDD §4.5).
    const back = apply(apply(taken, move(13, 12), 'B'), move(9, 1), 'W');
    expect(back.pendingRemoval).toBe(true);
    expect(millsThrough(back.board, 1, 'W')).toEqual([[0, 1, 2]]);
  });
});

describe('A7: a removal that ends the game by blocking, not by mill-out', () => {
  it('declares blocked when the removal seals the opponent in', () => {
    // Black: 16, 17, 18 (a mill, and sealed by White on 9, 19, 23) plus a loose
    // piece on 21. White slides 3→2 to make 0-1-2 and takes the loose piece;
    // Black then has exactly three pieces and nowhere to go.
    const s = state({
      board: boardOf('WW.W.... .W...... BBBW.B.W'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
    });
    const milled = apply(s, move(3, 2), 'W');
    expect(milled.pendingRemoval).toBe(true);
    expect(removablePieces(milled.board, 'B')).toEqual([21]);

    const after = apply(milled, remove(21), 'W');
    expect(after.board.filter((c) => c === 'B')).toHaveLength(3);
    expect(after.result).toEqual({ winner: 'W', reason: 'blocked' });
    expect(after.phase).toBe('over');
    expect(after.turn).toBe('B');
  });
});

describe('A8: turn ownership while a removal is owed', () => {
  const pending = () =>
    state({
      board: boardOf('WWW..... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      pendingRemoval: true,
      turn: 'W',
    });

  it('refuses every action from the player who does not owe the removal', () => {
    for (const a of [place(4), move(8, 15), remove(9), remove(13)]) {
      expect(() => apply(pending(), a, 'B')).toThrow(IllegalActionError);
    }
  });

  it('refuses a second removal after the first is taken', () => {
    const after = apply(pending(), remove(13), 'W');
    // The turn has passed, so White is refused on turn and Black on the flag.
    expect(() => apply(after, remove(8), 'W')).toThrow(/not W's turn/);
    expect(() => apply(after, remove(0), 'B')).toThrow(/no removal is pending/);
  });
});

describe('A9: agreed draw at awkward moments', () => {
  it('ends a game that owes a removal, clearing the pending flag', () => {
    const s = state({
      board: boardOf('WWW..... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      pendingRemoval: true,
    });
    const drawn = agreeDraw(s);
    expect(drawn.result).toEqual({ winner: null, reason: 'drawagreed' });
    expect(drawn.phase).toBe('over');
    expect(drawn.pendingRemoval).toBe(false);
    expect(legalActions(drawn)).toEqual([]);
  });

  it('refuses on a state that is over by phase alone', () => {
    expect(() => agreeDraw(state({ phase: 'over' }))).toThrow(/game is over/);
  });
});

describe('A10: purity of the helpers on the caller’s own arrays', () => {
  it('never writes to a board handed to formsMill, millsThrough or removablePieces', () => {
    const board = boardOf('WWW.B... BBB..... ..W.....');
    const snapshot = [...board];
    for (const p of POINTS) {
      formsMill(board, p, 'W');
      millsThrough(board, p, 'B');
    }
    removablePieces(board, 'W');
    removablePieces(board, 'B');
    expect(board).toEqual(snapshot);
  });

  it('accepts a frozen board and returns fresh, safe arrays', () => {
    const board = Object.freeze(boardOf('WWW..... BBB..... ........')) as Cell[];
    const got = removablePieces(board, 'B');
    got.push(99);
    expect(removablePieces(board, 'B')).toEqual([8, 9, 10]);
    const lines = millsThrough(board, 1, 'W');
    expect(lines).toEqual([[0, 1, 2]]);
    expect(Object.isFrozen(lines[0])).toBe(true);
  });
});

describe('A11: determinism', () => {
  it('gives identical results for identical inputs, twice over', () => {
    const build = () => {
      const rnd = mulberry32(7);
      let s = initialState();
      const trace: GameState[] = [s];
      for (let ply = 0; ply < 400 && s.result === null; ply++) {
        const options = legalActions(s);
        s = apply(s, options[Math.floor(rnd() * options.length)], s.turn);
        trace.push(s);
      }
      return trace;
    };
    const a = build();
    const b = build();
    expect(a).toEqual(b);
    expect(a[a.length - 1].result).not.toBeNull();
  });
});

describe('A12: the 50-move counter across the phase boundary', () => {
  it('does not count the placement that opens the movement phase', () => {
    const s = state({
      board: boardOf('W.W.W.W. B.B.W... B.......'),
      hand: { W: 0, B: 1 },
      turn: 'B',
    });
    const after = apply(s, place(20), 'B');
    expect(after.pendingRemoval).toBe(false);
    expect(after.phase).toBe('moving');
    expect(after.movesSinceRemoval).toBe(0);
    const slid = apply(after, move(0, 1), 'W');
    expect(slid.movesSinceRemoval).toBe(1);
  });

  it('carries a mid-turn counter through a pending removal unchanged', () => {
    const s = state({
      board: boardOf('WW.W.... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      movesSinceRemoval: 7,
    });
    const milled = apply(s, move(3, 2), 'W');
    expect(milled.movesSinceRemoval).toBe(8);
    expect(apply(milled, remove(13), 'W').movesSinceRemoval).toBe(0);
  });
});

describe('A13: no returned state is ever the input', () => {
  it('returns a different object for every action type', () => {
    const live = state({
      board: boardOf('WWW..... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
    });
    const pend = { ...live, pendingRemoval: true };
    const cases: [GameState, Action, Player][] = [
      [initialState(), place(4), 'W'],
      [live, move(0, 7), 'W'],
      [pend, remove(13), 'W'],
      [live, { type: 'resign' }, 'W'],
      [live, { type: 'forfeit', player: 'W' }, 'B'],
    ];
    for (const [s, a, by] of cases) {
      const next = apply(s, a, by);
      expect(next).not.toBe(s);
      expect(next.board).not.toBe(s.board);
      expect(next.hand).not.toBe(s.hand);
    }
    expect(agreeDraw(live)).not.toBe(live);
  });
});

describe('A16: sealing never reaches backwards into the caller’s objects', () => {
  it('does not freeze the input’s lastMove on the pass-through paths', () => {
    // place/move rebuild lastMove; remove, resign, forfeit and agreeDraw carry
    // the caller's object through, which is where an in-place freeze would bite.
    const withLastMove = (patch: Partial<GameState> = {}): GameState => ({
      ...initialState(),
      board: boardOf('WWW..... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      lastMove: { from: 3, to: 2 },
      ...patch,
    });
    const check = (s: GameState) => {
      expect(Object.isFrozen(s)).toBe(false);
      expect(Object.isFrozen(s.board)).toBe(false);
      expect(Object.isFrozen(s.hand)).toBe(false);
      expect(Object.isFrozen(s.lastMove)).toBe(false);
    };

    let s = withLastMove({ pendingRemoval: true });
    apply(s, remove(13), 'W');
    check(s);

    s = withLastMove();
    apply(s, { type: 'resign' }, 'B');
    check(s);

    s = withLastMove();
    apply(s, { type: 'forfeit', player: 'W' }, 'B');
    check(s);

    s = withLastMove();
    agreeDraw(s);
    check(s);

    s = withLastMove();
    apply(s, move(2, 3), 'W');
    check(s);
  });
});
