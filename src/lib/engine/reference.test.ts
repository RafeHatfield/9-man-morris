/**
 * A cross-check against an independent reference, written by a later critic and
 * kept. The reference engine here is transcribed from GDD §4 with its own tables
 * and its own transcription of the rules, so a shared misreading is the only way
 * both can be wrong together: over hundreds of seeded games it compares the whole
 * `legalActions` set and every field of every state except `lastMove`, which the
 * reference does not model and K5 covers on its own.
 *
 * The two symmetry proofs (colour swap, and the two-index ring rotation) are here
 * for what they say about the *engine* rather than the tables: that it treats the
 * two colours alike, and that it commutes with a relabelling of the board. They
 * are strictly weaker than the table comparisons at catching a corrupted table —
 * a wrong edit that happens to stay symmetric is invisible to them by
 * construction, and it is `board.test.ts` and the two hand-derivations that catch
 * that.
 */
import { describe, expect, it } from 'vitest';
import { ADJACENCY, LINES_THROUGH, MILLS, POINTS, POINT_COUNT } from './board';
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
import type { Action, Cell, GameState, Phase, Player, Result } from './types';

// ─── my own hand-derivation of the §4.1 tables, typed from the picture ───────
const K_MILLS: readonly (readonly number[])[] = [
  [0, 1, 2], [2, 3, 4], [4, 5, 6], [6, 7, 0],
  [8, 9, 10], [10, 11, 12], [12, 13, 14], [14, 15, 8],
  [16, 17, 18], [18, 19, 20], [20, 21, 22], [22, 23, 16],
  [1, 9, 17], [3, 11, 19], [5, 13, 21], [7, 15, 23],
];
const K_ADJ: readonly (readonly number[])[] = [
  [1, 7], [0, 2, 9], [1, 3], [2, 4, 11], [3, 5], [4, 6, 13], [5, 7], [0, 6, 15],
  [9, 15], [1, 8, 10, 17], [9, 11], [3, 10, 12, 19], [11, 13], [5, 12, 14, 21],
  [13, 15], [7, 8, 14, 23],
  [17, 23], [9, 16, 18], [17, 19], [11, 18, 20], [19, 21], [13, 20, 22],
  [21, 23], [15, 16, 22],
];

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);
const norm = (m: readonly number[]) => sorted(m).join(',');

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

// ─── K1: an independent reference engine, transcribed from GDD §4 ───────────
interface Ref {
  board: Cell[];
  hand: { W: number; B: number };
  turn: Player;
  phase: Phase;
  pending: boolean;
  msr: number;
  result: Result | null;
}
const opp = (p: Player): Player => (p === 'W' ? 'B' : 'W');
const rMill = (b: Cell[], p: number, who: Player) =>
  K_MILLS.some((m) => m.includes(p) && m.every((q) => b[q] === who));
function rRemovable(b: Cell[], foe: Player): number[] {
  const mine = POINTS.filter((p) => b[p] === foe);
  const loose = mine.filter((p) => !rMill(b, p, foe));
  return loose.length > 0 ? loose : mine;
}
const rCount = (r: Ref, p: Player) =>
  r.hand[p] + r.board.filter((c) => c === p).length;
function rLegal(r: Ref): Action[] {
  if (r.result !== null || r.phase === 'over') return [];
  if (r.pending) return rRemovable(r.board, opp(r.turn)).map(remove);
  if (r.phase === 'placing') {
    if (r.hand[r.turn] === 0) return [];
    return POINTS.filter((p) => r.board[p] === null).map(place);
  }
  const out: Action[] = [];
  for (const from of POINTS) {
    if (r.board[from] !== r.turn) continue;
    for (const to of K_ADJ[from]) if (r.board[to] === null) out.push(move(from, to));
  }
  return out;
}
function rFinish(r: Ref, winner: Player | null, reason: Result['reason']): Ref {
  return { ...r, phase: 'over', pending: false, result: { winner, reason } };
}
function rEndTurn(r: Ref): Ref {
  const next: Ref = { ...r, turn: opp(r.turn), pending: false };
  if (next.phase === 'placing' && next.hand.W === 0 && next.hand.B === 0) {
    next.phase = 'moving';
  }
  // GDD §4.6 loss checks, at the start of the new mover's turn.
  if (rCount(next, next.turn) < 3) return rFinish(next, opp(next.turn), 'millout');
  if (next.phase === 'moving' && rLegal(next).length === 0) {
    return rFinish(next, opp(next.turn), 'blocked');
  }
  // Documented: a decisive result beats the 50-move draw.
  if (next.msr >= DRAW_MOVE_LIMIT) return rFinish(next, null, 'draw50');
  return next;
}
function rAfter(r: Ref, point: number, by: Player): Ref {
  if (rMill(r.board, point, by) && rRemovable(r.board, opp(by)).length > 0) {
    return { ...r, pending: true };
  }
  return rEndTurn(r);
}
function rApply(r: Ref, a: Action, by: Player): Ref {
  if (a.type === 'place') {
    const board = [...r.board];
    board[a.point] = by;
    const hand = { ...r.hand };
    hand[by] -= 1;
    return rAfter({ ...r, board, hand }, a.point, by);
  }
  if (a.type === 'move') {
    const board = [...r.board];
    board[a.from] = null;
    board[a.to] = by;
    return rAfter({ ...r, board, msr: r.msr + 1 }, a.to, by);
  }
  if (a.type === 'remove') {
    const board = [...r.board];
    board[a.point] = null;
    return rEndTurn({ ...r, board, msr: 0 });
  }
  throw new Error('reference handles board actions only');
}
const toRef = (s: GameState): Ref => ({
  board: [...s.board],
  hand: { ...s.hand },
  turn: s.turn,
  phase: s.phase,
  pending: s.pendingRemoval,
  msr: s.movesSinceRemoval,
  result: s.result === null ? null : { ...s.result },
});

describe('K0: the §4.1 tables against my own reading of the diagram', () => {
  it('matches MILLS and ADJACENCY point for point', () => {
    expect(new Set(MILLS.map(norm))).toEqual(new Set(K_MILLS.map(norm)));
    expect(MILLS).toHaveLength(16);
    for (const p of POINTS) expect(sorted(ADJACENCY[p])).toEqual(sorted(K_ADJ[p]));
  });
});

describe('K1: full-state cross-check against an independent reference', () => {
  it('agrees on every field and every legal-action set, over 400 random games', () => {
    const key = (a: Action) => JSON.stringify(a);
    let plies = 0;
    const endings = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = mulberry32(seed * 7919 + 13);
      let s = initialState();
      let r = toRef(s);
      for (let ply = 0; ply < 500 && s.result === null; ply++) {
        const mine = rLegal(r);
        const theirs = legalActions(s);
        expect(new Set(theirs.map(key))).toEqual(new Set(mine.map(key)));
        expect(theirs).toHaveLength(mine.length);
        const a = mine[Math.floor(rnd() * mine.length)];
        s = apply(s, a, s.turn);
        r = rApply(r, a, r.turn);
        expect(toRef(s)).toEqual(r);
        plies++;
      }
      expect(s.result).not.toBeNull();
      endings.add(s.result!.reason);
    }
    expect(plies).toBeGreaterThan(5000);
    // Named for the same reason as C13's: one seed in four hundred ends `blocked`,
    // and a count would not notice it going missing.
    expect([...endings].sort()).toEqual(['blocked', 'draw50', 'millout']);
  }, 120_000);
});

describe('K2: colour symmetry — the rules must not favour a colour', () => {
  it('mirrors every outcome when both colours are swapped', () => {
    const flipB = (b: Cell[]): Cell[] =>
      b.map((c) => (c === null ? null : opponentOf(c)));
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = mulberry32(seed + 555);
      let s = initialState();
      let m = state({ turn: 'B' }); // the mirror: same position, colours swapped
      for (let ply = 0; ply < 500 && s.result === null; ply++) {
        const a = legalActions(s)[Math.floor(rnd() * legalActions(s).length)];
        expect(legalActions(m)).toEqual(legalActions(s));
        s = apply(s, a, s.turn);
        m = apply(m, a, m.turn);
        expect(m.board).toEqual(flipB(s.board));
        expect(m.hand).toEqual({ W: s.hand.B, B: s.hand.W });
        expect(m.turn).toBe(opponentOf(s.turn));
        expect(m.phase).toBe(s.phase);
        expect(m.pendingRemoval).toBe(s.pendingRemoval);
        expect(m.movesSinceRemoval).toBe(s.movesSinceRemoval);
        expect(m.result?.reason ?? null).toBe(s.result?.reason ?? null);
        expect(m.result?.winner ?? null).toBe(
          s.result?.winner == null ? (s.result?.winner ?? null) : opponentOf(s.result.winner),
        );
      }
    }
  }, 60_000);
});

describe('K3: board automorphism — a 90° ring rotation must commute', () => {
  // Rotating each ring by two indices maps the board graph onto itself.
  const rot = (p: number): number => {
    const ring = Math.floor(p / 8);
    return ring * 8 + ((p % 8) + 2) % 8;
  };
  const rotBoard = (b: Cell[]): Cell[] => {
    const out = Array<Cell>(POINT_COUNT).fill(null);
    for (const p of POINTS) out[rot(p)] = b[p];
    return out;
  };
  const rotAction = (a: Action): Action =>
    a.type === 'place'
      ? place(rot(a.point))
      : a.type === 'move'
        ? move(rot(a.from), rot(a.to))
        : a.type === 'remove'
          ? remove(rot(a.point))
          : a;

  it('is a genuine automorphism of the shipped tables', () => {
    expect(new Set(MILLS.map((m) => norm(m.map(rot))))).toEqual(
      new Set(MILLS.map(norm)),
    );
    for (const p of POINTS) {
      expect(sorted(ADJACENCY[p].map(rot))).toEqual(sorted(ADJACENCY[rot(p)]));
    }
  });

  it('produces the rotated result for the rotated game', () => {
    const key = (a: Action) => JSON.stringify(a);
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(seed * 31 + 3);
      let s = initialState();
      let t = initialState();
      for (let ply = 0; ply < 500 && s.result === null; ply++) {
        const opts = legalActions(s);
        expect(new Set(legalActions(t).map(key))).toEqual(
          new Set(opts.map((a) => key(rotAction(a)))),
        );
        const a = opts[Math.floor(rnd() * opts.length)];
        s = apply(s, a, s.turn);
        t = apply(t, rotAction(a), t.turn);
        expect(t.board).toEqual(rotBoard(s.board));
        expect(t.result).toEqual(s.result);
        expect(t.pendingRemoval).toBe(s.pendingRemoval);
        expect(t.movesSinceRemoval).toBe(s.movesSinceRemoval);
      }
    }
  }, 60_000);
});

describe('K4: legalActions during a removal owed in the PLACING phase', () => {
  it('offers removals only, never placements, even with pieces in hand', () => {
    const s = state({
      board: boardOf('WW...... BB...... ........'),
      hand: { W: 6, B: 7 },
    });
    const milled = apply(s, place(2), 'W');
    expect(milled.phase).toBe('placing');
    expect(milled.pendingRemoval).toBe(true);
    expect(milled.hand.W).toBe(5);
    const offered = legalActions(milled);
    expect(offered.every((a) => a.type === 'remove')).toBe(true);
    expect(offered.map((a) => (a as { point: number }).point).sort()).toEqual([8, 9]);
    for (const p of POINTS) {
      if (milled.board[p] === null) {
        expect(() => apply(milled, place(p), 'W')).toThrow(/removal is pending/);
      }
    }
  });
});

describe('K5: lastMove is the last board move, not clobbered by a removal', () => {
  it('survives the removal, the resignation, the forfeit and the agreed draw', () => {
    const s = state({
      board: boardOf('WW.W.... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      lastMove: { from: 9, to: 8 },
    });
    const milled = apply(s, move(3, 2), 'W');
    expect(milled.lastMove).toEqual({ from: 3, to: 2 });
    expect(apply(milled, remove(13), 'W').lastMove).toEqual({ from: 3, to: 2 });
    expect(apply(s, { type: 'resign' }, 'W').lastMove).toEqual({ from: 9, to: 8 });
    expect(apply(s, { type: 'forfeit', player: 'W' }, 'B').lastMove).toEqual({
      from: 9,
      to: 8,
    });
    expect(agreeDraw(s).lastMove).toEqual({ from: 9, to: 8 });
  });
});

describe('K6: millout beats blocked when a removal causes both', () => {
  it('reports millout, the condition GDD §4.6 lists first', () => {
    // Black holds 0, 8 and a loose piece at 12. White seals 0 and 8 with pieces
    // on 1, 7, 9 and 15, and completes 7-15-23 by sliding 22 to 23. Taking the
    // loose piece leaves Black on two AND with nowhere to go — both §4.6
    // conditions at once, which no mill-shaped fixture can produce: the two ends
    // of a mill are not adjacent to each other, only to the middle, so whichever
    // member is taken the vacated point is adjacent to at least one of the two
    // left standing — and they always have somewhere to go.
    const s = state({
      board: boardOf('BW.....W BW..B..W ......W.'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      turn: 'W',
    });
    const milled = apply(s, move(22, 23), 'W');
    expect(millsThrough(milled.board, 23, 'W')).toEqual([[7, 15, 23]]);
    expect(milled.pendingRemoval).toBe(true);

    // Black would be blocked as well: 0 and 8 have no empty neighbour.
    const after = apply(milled, remove(12), 'W');
    expect(after.board.filter((c) => c === 'B')).toHaveLength(2);
    expect(legalActions({ ...after, result: null, phase: 'moving' })).toEqual([]);
    expect(after.result).toEqual({ winner: 'W', reason: 'millout' });
  });
});

describe('K7: the all-in-mills exception with overlapping mills', () => {
  // Black holds 8-9-10 and 1-9-17: every Black piece is in a mill, and 9 is in
  // two of them, so the §4.5 exception has to offer all five.
  const overlapping = () =>
    state({
      board: boardOf('.BW.WW.. BBB..... .B......'),
      hand: { W: 1, B: 0 },
      turn: 'W',
    });

  it('offers every piece, including the one shared by two mills', () => {
    expect(removablePieces(overlapping().board, 'B')).toEqual([1, 8, 9, 10, 17]);
  });

  it('grants one removal, and one only, for a mill formed against it', () => {
    const milled = apply(overlapping(), place(6), 'W'); // completes 4-5-6
    expect(millsThrough(milled.board, 6, 'W')).toEqual([[4, 5, 6]]);
    expect(milled.pendingRemoval).toBe(true);

    const after = apply(milled, remove(9), 'W');
    expect(after.pendingRemoval).toBe(false);
    expect(after.turn).toBe('B');
    // No second bite: the turn has passed, so another removal is refused.
    expect(() => apply(after, remove(8), 'W')).toThrow(IllegalActionError);
  });
});

describe('K8: a mill that has nothing to take does not touch the draw counter', () => {
  it('keeps the counter and passes the turn', () => {
    const s = state({
      board: boardOf('WW...... ........ ........'),
      hand: { W: 5, B: 6 },
      turn: 'W',
    });
    const after = apply(s, place(2), 'W');
    expect(after.movesSinceRemoval).toBe(0);
    expect(after.pendingRemoval).toBe(false);
    expect(after.turn).toBe('B');
  });
});

describe('K9: applying the same action twice is referentially transparent', () => {
  it('gives deep-equal, non-identical results and leaves the source usable', () => {
    const s = state({
      board: boardOf('WW.W.... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
    });
    const a = apply(s, move(3, 2), 'W');
    const b = apply(s, move(3, 2), 'W');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.board).not.toBe(b.board);
    // And a state the engine returned can be replayed from again.
    const c = apply(a, remove(13), 'W');
    const d = apply(a, remove(13), 'W');
    expect(c).toEqual(d);
  });
});

describe('K10: malformed boards from a store', () => {
  const overlong = () =>
    state({
      board: [...boardOf('W.WW.... .B.BB... ........'), 'W'] as Cell[],
      hand: { W: 0, B: 0 },
      phase: 'moving',
    });

  it('offers nothing for a board that is not 24 points, and never throws doing it', () => {
    // `legalActions` and the board actions must agree: a state the actions refuse
    // is a state with no legal actions, not one with hints the server rejects.
    expect(() => legalActions(overlong())).not.toThrow();
    expect(legalActions(overlong())).toEqual([]);
    // The pure helpers still read exactly the 24 points a board has.
    expect(removablePieces(overlong().board, 'W')).toEqual([0, 2, 3]);
  });

  it('still refuses an off-board point with IllegalActionError', () => {
    expect(() => apply(overlong(), move(24, 2), 'W')).toThrow(IllegalActionError);
    expect(() => formsMill(overlong().board, 24, 'W')).toThrow(IllegalActionError);
  });
});

describe('K11: IllegalActionError identifies itself', () => {
  it('carries its own name', () => {
    const e = new IllegalActionError('x');
    expect(e.name).toBe('IllegalActionError');
    expect(String(e)).toContain('IllegalActionError');
  });
});

describe('K12: millsThrough is exhaustive at every point and both lines', () => {
  it('returns both crossing lines for all 24 points when both are complete', () => {
    for (const p of POINTS) {
      const board = Array<Cell>(POINT_COUNT).fill(null);
      for (const q of LINES_THROUGH[p].flat()) board[q] = 'W';
      expect(millsThrough(board, p, 'W')).toHaveLength(2);
      expect(formsMill(board, p, 'W')).toBe(true);
      // and nothing for the other colour
      expect(millsThrough(board, p, 'B')).toEqual([]);
    }
  });
});

describe('K13: a blocked loss is never declared while the mover still has a hand', () => {
  it('lets a fully walled-in player place out of trouble', () => {
    // Black mills and takes White's only mobile piece, leaving White walled in on
    // 0/1/2 — but with two pieces still in hand, so §4.6's block cannot apply.
    const s = state({
      board: boardOf('WWWB...B B.B..... ....W...'),
      hand: { W: 2, B: 1 },
      turn: 'B',
      phase: 'placing',
    });
    const after = apply(s, place(9), 'B');
    expect(after.turn).toBe('B'); // 8-9-10 mills for Black
    const taken = apply(after, remove(20), 'B');
    expect(taken.result).toBeNull();
    expect(taken.turn).toBe('W');
    expect(legalActions(taken).every((a) => a.type === 'place')).toBe(true);
  });
});

describe('K14: forfeit and resign preserve everything but the ending', () => {
  it('leaves board, hand, counter and lastMove alone', () => {
    const s = state({
      board: boardOf('WW.W.... BBB..B.. ........'),
      hand: { W: 0, B: 0 },
      phase: 'moving',
      movesSinceRemoval: 17,
      lastMove: { from: 4, to: 3 },
    });
    for (const out of [
      apply(s, { type: 'resign' }, 'W'),
      apply(s, { type: 'forfeit', player: 'W' }, 'B'),
      agreeDraw(s),
    ]) {
      expect(out.board).toEqual(s.board);
      expect(out.hand).toEqual(s.hand);
      expect(out.movesSinceRemoval).toBe(17);
      expect(out.lastMove).toEqual({ from: 4, to: 3 });
      expect(out.turn).toBe('W');
      expect(out.phase).toBe('over');
    }
  });
});
