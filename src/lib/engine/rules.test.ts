/**
 * Adversarial rule-edge tests, written independently of `engine.test.ts` by the
 * critic agent and kept: the property test and the fuzz are the two here that
 * would catch a regression nobody thought to write a case for.
 */
import { describe, expect, it } from 'vitest';
import { ADJACENCY, LINES_THROUGH, MILLS, POINTS, POINT_COUNT } from './board';
import {
  DRAW_MOVE_LIMIT,
  IllegalActionError,
  apply,
  formsMill,
  initialState,
  legalActions,
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

function pieces(s: GameState, p: Player): number {
  return s.hand[p] + s.board.filter((c) => c === p).length;
}

// ── C1 ───────────────────────────────────────────────────────────────────────
describe('C1: mill against an opponent whose pieces are ALL inside mills', () => {
  it('offers every opponent piece, taken by a slide-formed mill', () => {
    // White 0,1 + 3; sliding 3→2 completes 0-1-2.
    // Black holds two full inner mills: 16-17-18 and 20-21-22.
    const board = boardOf('WW.W.... ........ BBB.BBB.');
    const g: GameState = state({
      board,
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
    });
    expect(removablePieces(g.board, 'B')).toEqual([16, 17, 18, 20, 21, 22]);
    const after = apply(g, move(3, 2), 'W');
    expect(after.pendingRemoval).toBe(true);
    expect(legalActions(after).map((a) => a as { point: number }).length).toBe(6);
    const taken = apply(after, remove(17), 'W');
    expect(taken.board[17]).toBeNull();
    expect(taken.turn).toBe('B');
    expect(taken.result).toBeNull();
  });

  it('protects mill pieces the moment one loose piece exists', () => {
    const board = boardOf('WW.W.... .....B.. BBB.BBB.');
    const g: GameState = state({
      board,
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
    });
    const after = apply(g, move(3, 2), 'W');
    expect(legalActions(after)).toEqual([remove(13)]);
    expect(() => apply(after, remove(16), 'W')).toThrow(/protected by a mill/);
  });
});

// ── C2 ───────────────────────────────────────────────────────────────────────
describe('C2: mill while the opponent has nothing on the board but pieces in hand', () => {
  it('passes the turn instead of deadlocking, and the game continues', () => {
    const g = state({
      board: boardOf('WW...... ........ ........'),
      hand: { W: 6, B: 7 },
      turn: 'W',
    });
    const after = apply(g, place(2), 'W');
    expect(formsMill(after.board, 2, 'W')).toBe(true);
    expect(after.pendingRemoval).toBe(false);
    expect(after.turn).toBe('B');
    expect(after.result).toBeNull();
    expect(after.phase).toBe('placing');
    // Black can still play.
    expect(legalActions(after).length).toBe(21);
    expect(apply(after, place(8), 'B').board[8]).toBe('B');
  });
});

// ── C3 ───────────────────────────────────────────────────────────────────────
describe('C3: hand exhaustion on a ply that also forms a mill', () => {
  it('keeps the placing phase through the pending removal, flips after it', () => {
    const g = state({
      board: boardOf('W..WW.W. BB...... ........'),
      hand: { W: 0, B: 1 },
      turn: 'B',
    });
    const milled = apply(g, place(10), 'B'); // 8-9-10
    expect(milled.pendingRemoval).toBe(true);
    expect(milled.turn).toBe('B');
    expect(milled.hand).toEqual({ W: 0, B: 0 });
    // The removal is still part of the placement phase.
    expect(milled.phase).toBe('placing');

    const after = apply(milled, remove(6), 'B');
    expect(after.phase).toBe('moving');
    expect(after.turn).toBe('W');
    expect(after.pendingRemoval).toBe(false);
    expect(after.result).toBeNull();
    expect(after.movesSinceRemoval).toBe(0);
  });

  it('resolves millout on the removal that empties the last hand', () => {
    const g = state({
      board: boardOf('W..WW... BB...... ........'),
      hand: { W: 0, B: 1 },
      turn: 'B',
    });
    const milled = apply(g, place(10), 'B');
    const after = apply(milled, remove(4), 'B'); // White down to two
    expect(after.result).toEqual({ winner: 'B', reason: 'millout' });
    expect(after.phase).toBe('over');
  });
});

// ── C4 ───────────────────────────────────────────────────────────────────────
describe('C4: removals to exactly three and exactly two', () => {
  it('leaves the game alive on exactly three', () => {
    const g = state({
      board: boardOf('WWW..W.. BBBB.... ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
      pendingRemoval: true,
    });
    const after = apply(g, remove(11), 'W');
    expect(pieces(after, 'B')).toBe(3);
    expect(after.result).toBeNull();
    expect(after.turn).toBe('B');
  });

  it('ends the game on exactly two', () => {
    const g = state({
      board: boardOf('WWW..W.. BBB..... ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
      pendingRemoval: true,
    });
    const after = apply(g, remove(9), 'W');
    expect(pieces(after, 'B')).toBe(2);
    expect(after.result).toEqual({ winner: 'W', reason: 'millout' });
  });
});

// ── C5 ───────────────────────────────────────────────────────────────────────
describe('C5: blocked at the exact moment the placement phase ends', () => {
  it('loses immediately on entering the movement phase with no move', () => {
    // White sealed on 16,17,18; Black at 19 and 23; Black places the last piece on 9.
    const g = state({
      board: boardOf('........ ........ WWWB...B'),
      hand: { W: 0, B: 1 },
      turn: 'B',
    });
    expect(g.board[16]).toBe('W');
    expect(g.board[19]).toBe('B');
    expect(g.board[23]).toBe('B');
    const after = apply(g, place(9), 'B');
    expect(after.phase).toBe('over');
    expect(after.result).toEqual({ winner: 'B', reason: 'blocked' });
  });

  it('does not call a block while pieces remain in hand', () => {
    // Unequal hands: a shape the engine never produces from `initialState()`, but
    // one it will accept. §4.6's block is a movement-phase rule, so it does not
    // fire here — and White, with an empty hand and the phase still `placing`, is
    // stranded rather than beaten, which is exactly why `unplayable` refuses to
    // take a board action on that state rather than playing on.
    const g = state({
      board: boardOf('........ ........ WWWB...B'),
      hand: { W: 0, B: 2 },
      turn: 'B',
    });
    const after = apply(g, place(9), 'B');
    expect(after.phase).toBe('placing');
    expect(after.result).toBeNull();
    expect(after.turn).toBe('W');
    expect(legalActions(after)).toEqual([]);
    expect(() => apply(after, place(0), 'W')).toThrow(/nothing left to place/);
  });
});

// ── C6 ───────────────────────────────────────────────────────────────────────
describe('C6: the 50-move counter never moves during placement', () => {
  it('stays at zero across a legal, mill-free 18-ply placement', () => {
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 11, 18, 13, 20, 15, 22, 10];
    let s = initialState();
    for (const [i, point] of order.entries()) {
      s = apply(s, place(point), i % 2 === 0 ? 'W' : 'B');
      expect(s.pendingRemoval).toBe(false); // the script forms no mill
      expect(s.movesSinceRemoval).toBe(0);
    }
    expect(s.hand).toEqual({ W: 0, B: 0 });
    expect(s.phase).toBe('moving');
    expect(s.movesSinceRemoval).toBe(0);
  });

  it('stays at zero across a mill and a removal made during placement', () => {
    const g = state({
      board: boardOf('WW...... BB...... ........'),
      hand: { W: 6, B: 7 },
      turn: 'W',
    });
    const milled = apply(g, place(2), 'W');
    expect(milled.pendingRemoval).toBe(true);
    expect(milled.movesSinceRemoval).toBe(0);
    const after = apply(milled, remove(8), 'W');
    expect(after.movesSinceRemoval).toBe(0);
    expect(after.phase).toBe('placing');
  });
});

// ── C7 ───────────────────────────────────────────────────────────────────────
describe('C7: a spoke mill broken and re-formed by sliding out and back', () => {
  it('counts the re-formation as a new mill', () => {
    const g = state({
      board: boardOf('WW...... .W...BBB .W......'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
    });
    expect(formsMill(g.board, 17, 'W')).toBe(true); // 1-9-17
    const out = apply(g, move(17, 18), 'W');
    expect(out.pendingRemoval).toBe(false);
    expect(formsMill(out.board, 18, 'W')).toBe(false);
    const b = apply(out, move(13, 12), 'B');
    const back = apply(b, move(18, 17), 'W');
    expect(formsMill(back.board, 17, 'W')).toBe(true);
    expect(back.pendingRemoval).toBe(true);
    expect(back.turn).toBe('W');
  });
});

// ── C8 ───────────────────────────────────────────────────────────────────────
describe('C8: sliding along a spoke to complete a spoke mill', () => {
  it('detects the mill on arrival at the middle-ring midpoint', () => {
    const g = state({
      board: boardOf('.W...... W....... .W...BBB'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
    });
    const after = apply(g, move(8, 9), 'W'); // completes 1-9-17
    expect(formsMill(after.board, 9, 'W')).toBe(true);
    expect(after.pendingRemoval).toBe(true);
  });

  it('detects it for every spoke, in both directions of travel', () => {
    for (const [outer, mid, inner] of [
      [1, 9, 17],
      [3, 11, 19],
      [5, 13, 21],
      [7, 15, 23],
    ]) {
      for (const from of ADJACENCY[mid].filter(
        (p) => p !== outer && p !== inner,
      )) {
        const board = Array<Cell>(POINT_COUNT).fill(null);
        board[outer] = 'W';
        board[inner] = 'W';
        board[from] = 'W';
        const free = POINTS.filter((p) => board[p] === null && p !== mid);
        board[free[0]] = 'B';
        board[free[1]] = 'B';
        board[free[2]] = 'B';
        const g = state({
          board,
          hand: { W: 0, B: 0 },
          phase: 'moving',
          turn: 'W',
        });
        const after = apply(g, move(from, mid), 'W');
        expect(after.pendingRemoval).toBe(true);
      }
    }
  });
});

// ── C9 ───────────────────────────────────────────────────────────────────────
describe('C9: double mills', () => {
  it('is topologically impossible to form two mills with one slide', () => {
    // Every neighbour of p lies on one of the two lines through p, so the
    // vacated square always breaks one of the two candidate mills.
    for (const p of POINTS) {
      const onLines = new Set(LINES_THROUGH[p].flat());
      for (const q of ADJACENCY[p]) expect(onLines.has(q)).toBe(true);
    }
  });

  it('yields exactly one removal for a placement double mill, at every crossing', () => {
    // Every point crosses two lines — the twelve corners as much as the twelve
    // midpoints — so a double mill is reachable at all 24.
    for (const mid of POINTS) {
      const [lineA, lineB] = LINES_THROUGH[mid];
      const board = Array<Cell>(POINT_COUNT).fill(null);
      for (const p of [...lineA, ...lineB]) if (p !== mid) board[p] = 'W';
      const free = POINTS.filter((p) => board[p] === null && p !== mid);
      board[free[0]] = 'B';
      board[free[1]] = 'B';
      board[free[2]] = 'B';
      board[free[3]] = 'B';
      const g = state({ board, hand: { W: 1, B: 4 }, turn: 'W' });
      const milled = apply(g, place(mid), 'W');
      expect(milled.pendingRemoval).toBe(true);
      // Both lines really are mills.
      expect(lineA.every((p) => milled.board[p] === 'W')).toBe(true);
      expect(lineB.every((p) => milled.board[p] === 'W')).toBe(true);
      const targets = removablePieces(milled.board, 'B');
      expect(targets.length).toBeGreaterThan(0);
      const after = apply(milled, remove(targets[0]), 'W');
      expect(after.pendingRemoval).toBe(false);
      expect(after.turn).toBe('B');
      // No second bite.
      const rest = removablePieces(after.board, 'B');
      expect(() => apply(after, remove(rest[0]), 'W')).toThrow(IllegalActionError);
    }
  });
});

// ── C10 ──────────────────────────────────────────────────────────────────────
describe('C10: resignation and forfeit, right and wrong', () => {
  it('refuses a forfeit against the player not on the clock', () => {
    const s = initialState();
    expect(() => apply(s, { type: 'forfeit', player: 'B' }, 'W')).toThrow(
      IllegalActionError,
    );
  });

  it('refuses a self-claimed forfeit', () => {
    const s = initialState();
    expect(() => apply(s, { type: 'forfeit', player: 'W' }, 'W')).toThrow(
      IllegalActionError,
    );
  });

  it('allows a forfeit claim while the opponent owes a removal', () => {
    const g = state({
      board: boardOf('WWW..... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
      pendingRemoval: true,
    });
    const after = apply(g, { type: 'forfeit', player: 'W' }, 'B');
    expect(after.result).toEqual({ winner: 'B', reason: 'forfeit' });
    expect(after.pendingRemoval).toBe(false);
    expect(after.phase).toBe('over');
  });

  it('refuses anything once a result exists', () => {
    const over = state({
      phase: 'over',
      result: { winner: 'W', reason: 'draw50' },
    });
    for (const a of [
      place(0),
      move(0, 1),
      remove(0),
      { type: 'resign' } as Action,
      { type: 'forfeit', player: 'W' } as Action,
    ]) {
      expect(() => apply(over, a, 'W')).toThrow(/the game is over/);
      expect(() => apply(over, a, 'B')).toThrow(/the game is over/);
    }
  });

  it('lets either side resign out of turn, and mid-removal', () => {
    const g = state({
      board: boardOf('WWW..... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
      pendingRemoval: true,
    });
    expect(apply(g, { type: 'resign' }, 'B').result).toEqual({
      winner: 'W',
      reason: 'resign',
    });
    expect(apply(g, { type: 'resign' }, 'W').result).toEqual({
      winner: 'B',
      reason: 'resign',
    });
  });
});

// ── C11 ──────────────────────────────────────────────────────────────────────
describe('C11: apply never mutates the state it is given', () => {
  const cases: [string, GameState, Action, Player][] = [
    ['place', initialState(), place(4), 'W'],
    [
      'place forming a mill',
      state({ board: boardOf('WW...... B....... ........'), hand: { W: 7, B: 8 } }),
      place(2),
      'W',
    ],
    [
      'move',
      state({
        board: boardOf('W.WW.... .B.BB... ........'),
        hand: { W: 0, B: 0 },
        phase: 'moving',
      }),
      move(0, 1),
      'W',
    ],
    [
      'remove',
      state({
        board: boardOf('WWW..... BBB..B.. ........'),
        hand: { W: 0, B: 0 },
        phase: 'moving',
        pendingRemoval: true,
      }),
      remove(13),
      'W',
    ],
    ['resign', initialState(), { type: 'resign' }, 'B'],
    ['forfeit', initialState(), { type: 'forfeit', player: 'W' }, 'B'],
  ];

  it.each(cases)('%s leaves the input deep-equal to its snapshot', (_n, s, a, by) => {
    const snapshot = structuredClone(s);
    const next = apply(s, a, by);
    expect(s).toEqual(snapshot);
    expect(next).not.toBe(s);
  });

  it.each(cases.filter(([n]) => !n.startsWith('res') && !n.startsWith('for')))(
    '%s returns a state whose board is a fresh array',
    (_n, s, a, by) => {
      const next = apply(s, a, by);
      expect(next.board).not.toBe(s.board);
    },
  );

  it('leaves the input untouched when it throws', () => {
    const s = initialState();
    const snapshot = structuredClone(s);
    expect(() => apply(s, place(0), 'B')).toThrow();
    expect(() => apply(s, move(0, 1), 'W')).toThrow();
    expect(() => apply(s, remove(0), 'W')).toThrow();
    expect(s).toEqual(snapshot);
  });
});

// ── C12 ──────────────────────────────────────────────────────────────────────
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

/** Every state visited by a random playthrough, plus the invariants that must hold. */
function playout(seed: number): GameState[] {
  const rnd = mulberry32(seed);
  const seen: GameState[] = [];
  let s = initialState();
  for (let ply = 0; ply < 400 && s.result === null; ply++) {
    seen.push(s);
    const options = legalActions(s);
    expect(options.length).toBeGreaterThan(0); // no deadlock while the game is live
    const a = options[Math.floor(rnd() * options.length)];
    s = apply(s, a, s.turn);
  }
  seen.push(s);
  return seen;
}

describe('C12: legalActions and apply agree (property test over random play)', () => {
  it('accepts every action legalActions offers, and rejects every board action it does not', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const states = playout(seed);
      const sampled = states.filter((_, i) => i % 7 === 0 || i === states.length - 1);
      for (const s of sampled) {
        if (s.result !== null) {
          expect(legalActions(s)).toEqual([]);
          continue;
        }
        const offered = legalActions(s);
        const key = (a: Action) => JSON.stringify(a);
        const offeredKeys = new Set(offered.map(key));

        for (const a of offered) {
          expect(() => apply(s, a, s.turn)).not.toThrow();
        }

        // Every board action that is NOT offered must be rejected.
        const universe: Action[] = [];
        for (const p of POINTS) {
          universe.push(place(p), remove(p));
          for (const q of ADJACENCY[p]) universe.push(move(p, q));
        }
        for (const a of universe) {
          if (offeredKeys.has(key(a))) continue;
          expect(() => apply(s, a, s.turn)).toThrow(IllegalActionError);
          // ...and also for the player who is not to move.
          expect(() => apply(s, a, opponentOf(s.turn))).toThrow(IllegalActionError);
        }
      }
    }
  }, 60_000);
});

// ── C13 ──────────────────────────────────────────────────────────────────────
describe('C13: invariants hold across many random games', () => {
  it('never breaks a structural or rules invariant, and always terminates', () => {
    const reasons = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const states = playout(seed);
      const final = states[states.length - 1];
      expect(final.result).not.toBeNull();
      reasons.add(final.result!.reason);

      let sawMoving = false;
      for (const s of states) {
        expect(s.board).toHaveLength(POINT_COUNT);
        expect(pieces(s, 'W')).toBeLessThanOrEqual(9);
        expect(pieces(s, 'B')).toBeLessThanOrEqual(9);
        expect(s.hand.W).toBeGreaterThanOrEqual(0);
        expect(s.hand.B).toBeGreaterThanOrEqual(0);
        expect(s.movesSinceRemoval).toBeLessThanOrEqual(DRAW_MOVE_LIMIT);

        if (s.phase === 'placing') {
          // The counter is a movement-phase counter only (GDD §7.1).
          expect(s.movesSinceRemoval).toBe(0);
          // A player to move in the placement phase always has a piece to place.
          if (!s.pendingRemoval) expect(s.hand[s.turn]).toBeGreaterThan(0);
        }
        if (s.phase === 'moving') sawMoving = true;
        // Phase never runs backwards.
        if (sawMoving) expect(s.phase).not.toBe('placing');
        if (s.result !== null) {
          expect(s.phase).toBe('over');
          expect(s.pendingRemoval).toBe(false);
        }
        if (s.pendingRemoval) {
          expect(removablePieces(s.board, opponentOf(s.turn)).length).toBeGreaterThan(0);
        }
      }

      // Terminal reasons must match the position.
      const r = final.result!;
      if (r.reason === 'millout') {
        expect(pieces(final, opponentOf(r.winner!))).toBeLessThan(3);
      }
      if (r.reason === 'blocked') {
        const loser = opponentOf(r.winner!);
        expect(final.turn).toBe(loser);
        const anyMove = POINTS.some(
          (p) =>
            final.board[p] === loser &&
            ADJACENCY[p].some((q) => final.board[q] === null),
        );
        expect(anyMove).toBe(false);
        expect(pieces(final, loser)).toBeGreaterThanOrEqual(3);
      }
      if (r.reason === 'draw50') {
        expect(final.movesSinceRemoval).toBe(DRAW_MOVE_LIMIT);
        expect(r.winner).toBeNull();
      }
    }
    // Named, not counted. Over these seeds exactly one game ends `blocked`, so a
    // count is satisfied by `millout` + `draw50` alone and the six assertions in
    // the `blocked` arm above could stop running — under a new RNG, a different
    // ply cap, a wider seed range — with this test still green.
    expect([...reasons].sort()).toEqual(['blocked', 'draw50', 'millout']);
  }, 60_000);
});

// ── C14 ──────────────────────────────────────────────────────────────────────
describe('C14: mill totals and the removal it grants', () => {
  it('grants a removal for each of the 16 lines, formed by placement', () => {
    for (const mill of MILLS) {
      const board = Array<Cell>(POINT_COUNT).fill(null);
      board[mill[0]] = 'W';
      board[mill[1]] = 'W';
      const free = POINTS.filter((p) => board[p] === null && p !== mill[2]);
      board[free[0]] = 'B';
      board[free[1]] = 'B';
      board[free[2]] = 'B';
      const g = state({ board, hand: { W: 3, B: 3 }, turn: 'W' });
      const after = apply(g, place(mill[2]), 'W');
      expect(after.pendingRemoval).toBe(true);
      expect(after.turn).toBe('W');
    }
  });
});

// ── C15 ───────────────────────────────────────────────────────────────────────────
describe('C15: public helpers on hostile input', () => {
  it('rejects an off-board point the same way the rest of the engine does', () => {
    const board = Array<Cell>(POINT_COUNT).fill(null);
    for (const bad of [-1, POINT_COUNT, 99, 1.5, Number.NaN]) {
      expect(() => formsMill(board, bad, 'W')).toThrow(IllegalActionError);
    }
  });

  it('removablePieces never returns a point holding the wrong colour', () => {
    const board = boardOf('WWWBBB.. BBB..... ........');
    for (const p of removablePieces(board, 'B')) expect(board[p]).toBe('B');
    for (const p of removablePieces(board, 'W')) expect(board[p]).toBe('W');
  });
});

// ── C16 ───────────────────────────────────────────────────────────────────────────
describe('C16: a decisive result beats the 50-move draw', () => {
  it('scores a win when the fiftieth move also walls the opponent in', () => {
    // White's move both hits the 50th ply and leaves Black with no legal move.
    const g = state({
      board: boardOf('BBBW...W ..W..... ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
      movesSinceRemoval: DRAW_MOVE_LIMIT - 1,
    });
    const after = apply(g, move(10, 9), 'W');
    expect(after.result).toEqual({ winner: 'W', reason: 'blocked' });
  });

  it('still draws on the fiftieth move when the opponent can move', () => {
    const g = state({
      board: boardOf('W.WW.... .B.BB... ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      movesSinceRemoval: DRAW_MOVE_LIMIT - 1,
    });
    expect(apply(g, move(0, 1), 'W').result).toEqual({
      winner: null,
      reason: 'draw50',
    });
  });
});

// ── C17 ───────────────────────────────────────────────────────────────────────────
describe('C17: every mill line completed by a slide, not only by a placement', () => {
  it('grants a removal on all 16 lines when the last piece slides in', () => {
    for (const mill of MILLS) {
      for (const target of mill) {
        // Slide into `target` from a neighbour outside the mill being formed, so
        // the vacated point cannot be part of it. (It may lie on `target`'s other
        // line, which is fine — that line is not the one under test.)
        const onOwnLines = new Set(LINES_THROUGH[target].flat());
        const from = ADJACENCY[target].find((p) => !mill.includes(p));
        // Every mill member has one: a ring corner's two neighbours straddle the
        // line, and a midpoint has its spoke. Asserted rather than skipped, so a
        // wrong table would fail this test instead of quietly shrinking it.
        expect(from).toBeDefined();

        const board = Array<Cell>(POINT_COUNT).fill(null);
        for (const p of mill) if (p !== target) board[p] = 'W';
        board[from!] = 'W';
        const free = POINTS.filter(
          (p) => board[p] === null && p !== target && !onOwnLines.has(p),
        );
        for (const p of free.slice(0, 4)) board[p] = 'B';

        const g = state({ board, hand: { W: 0, B: 0 }, phase: 'moving' });
        const after = apply(g, move(from!, target), 'W');
        expect(formsMill(after.board, target, 'W')).toBe(true);
        expect(after.pendingRemoval).toBe(true);
        expect(after.turn).toBe('W');
      }
    }
  });
});

// ── C18 ───────────────────────────────────────────────────────────────────────────
describe('C18: a mill formed on the fiftieth movement ply', () => {
  const position = () =>
    state({
      board: boardOf('WW.W.... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      movesSinceRemoval: DRAW_MOVE_LIMIT - 1,
    });

  it('takes the removal rather than drawing, and the removal resets the counter', () => {
    // The mill path skips endTurn entirely, so the draw check never runs on this
    // ply — the removal that follows zeroes the counter (GDD §4.5, §4.6).
    const milled = apply(position(), move(3, 2), 'W');
    expect(milled.movesSinceRemoval).toBe(DRAW_MOVE_LIMIT);
    expect(milled.pendingRemoval).toBe(true);
    expect(milled.result).toBeNull();

    const after = apply(milled, remove(13), 'W');
    expect(after.movesSinceRemoval).toBe(0);
    expect(after.result).toBeNull();
    expect(after.turn).toBe('B');
  });

  it('scores a mill-out, not a draw, when that removal is the third-last piece', () => {
    const s = state({
      board: boardOf('WW.W.... BBB..... ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      movesSinceRemoval: DRAW_MOVE_LIMIT - 1,
    });
    const milled = apply(s, move(3, 2), 'W');
    expect(removablePieces(milled.board, 'B')).toEqual([8, 9, 10]);
    expect(apply(milled, remove(9), 'W').result).toEqual({
      winner: 'W',
      reason: 'millout',
    });
  });
});

// ── C19 ───────────────────────────────────────────────────────────────────────────
describe('C19: fifty real plies to the draw, not a seeded counter', () => {
  it('draws on the fiftieth alternating slide and not on the forty-ninth', () => {
    const start = state({
      board: boardOf('W.W.W... B.B.B... ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
    });

    let s = start;
    let ply = 0;
    // Three pieces each: White on the outer corners 0/2/4, Black on the middle
    // corners 8/10/12 — neither set is a line, and both sides have several legal
    // moves. The shuttle below is the one this test chooses, because each of its
    // four destination squares leaves both of that square's lines a piece short,
    // so fifty plies pass with no mill and therefore no removal.
    const shuttle: [number, number][] = [
      [4, 5],
      [12, 13],
      [5, 4],
      [13, 12],
    ];
    while (s.result === null && ply < DRAW_MOVE_LIMIT) {
      const [from, to] = shuttle[ply % shuttle.length];
      s = apply(s, move(from, to), s.turn);
      ply++;
      expect(s.movesSinceRemoval).toBe(ply);
      expect(s.pendingRemoval).toBe(false);
      if (ply < DRAW_MOVE_LIMIT) expect(s.result).toBeNull();
    }

    expect(ply).toBe(DRAW_MOVE_LIMIT);
    expect(s.result).toEqual({ winner: null, reason: 'draw50' });
  });
});
