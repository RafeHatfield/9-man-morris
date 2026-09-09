import { describe, expect, it } from 'vitest';
import { ADJACENCY, LINES_THROUGH, MILLS, POINTS, POINT_COUNT } from './board';
import { apply, formsMill, initialState, millsThrough } from './engine';
import type { Cell, GameState } from './types';

describe('adjacency table', () => {
  it('has an entry for every point', () => {
    expect(ADJACENCY).toHaveLength(POINT_COUNT);
  });

  it('gives every point 2–4 neighbours (GDD §4.1)', () => {
    for (const p of POINTS) {
      expect(ADJACENCY[p].length).toBeGreaterThanOrEqual(2);
      expect(ADJACENCY[p].length).toBeLessThanOrEqual(4);
    }
  });

  it('is symmetric, self-free and in range', () => {
    for (const p of POINTS) {
      expect(new Set(ADJACENCY[p]).size).toBe(ADJACENCY[p].length);
      for (const q of ADJACENCY[p]) {
        expect(q).toBeGreaterThanOrEqual(0);
        expect(q).toBeLessThan(POINT_COUNT);
        expect(q).not.toBe(p);
        expect(ADJACENCY[q]).toContain(p);
      }
    }
  });

  it('allows a slide across every adjacency, both ways', () => {
    let edges = 0;
    for (const from of POINTS) {
      for (const to of ADJACENCY[from]) {
        edges++;
        const board = Array<Cell>(POINT_COUNT).fill(null);
        board[from] = 'W';
        // Three a side: two spares for White, who also has the moving piece, and
        // three for Black — so neither is under §4.6's three, whatever the move.
        const spares = POINTS.filter((p) => p !== from && p !== to);
        board[spares[0]] = 'W';
        board[spares[1]] = 'W';
        board[spares[2]] = 'B';
        board[spares[3]] = 'B';
        board[spares[4]] = 'B';
        const s: GameState = {
          ...initialState(),
          board,
          hand: { W: 0, B: 0 },
          phase: 'moving',
        };
        const next = apply(s, { type: 'move', from, to }, 'W');
        expect(next.board[from]).toBeNull();
        expect(next.board[to]).toBe('W');
      }
    }
    expect(edges).toBe(64); // 32 undirected edges, counted from both ends
  });
});

describe('mill table', () => {
  it('has the 16 distinct lines of three in-range points', () => {
    expect(MILLS).toHaveLength(16);
    expect(new Set(MILLS.map((m) => [...m].sort((a, b) => a - b).join(','))).size).toBe(16);
    for (const mill of MILLS) {
      expect(new Set(mill).size).toBe(3);
      for (const p of mill) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(POINT_COUNT);
      }
    }
  });

  it('joins consecutive points of every line by an adjacency', () => {
    for (const [a, b, c] of MILLS) {
      expect(ADJACENCY[a]).toContain(b);
      expect(ADJACENCY[b]).toContain(c);
    }
  });

  it('puts every point on exactly 2 lines (GDD §4.1)', () => {
    for (const p of POINTS) {
      expect(LINES_THROUGH[p]).toHaveLength(2);
      for (const mill of LINES_THROUGH[p]) expect(mill).toContain(p);
    }
  });

  it('recognises every mill line, for both players', () => {
    for (const mill of MILLS) {
      for (const player of ['W', 'B'] as const) {
        const board = Array<Cell>(POINT_COUNT).fill(null);
        for (const p of mill) board[p] = player;
        for (const p of mill) expect(formsMill(board, p, player)).toBe(true);
        // The same three points are not a mill for the other player.
        const other = player === 'W' ? 'B' : 'W';
        for (const p of mill) expect(formsMill(board, p, other)).toBe(false);
      }
    }
  });

  it('does not see a mill in two of three, or in a mixed line', () => {
    for (const [a, b, c] of MILLS) {
      const board = Array<Cell>(POINT_COUNT).fill(null);
      board[a] = 'W';
      board[b] = 'W';
      expect(formsMill(board, a, 'W')).toBe(false);
      board[c] = 'B';
      expect(formsMill(board, a, 'W')).toBe(false);
    }
  });
});

describe('the tables are frozen', () => {
  const written = (write: () => void): boolean => {
    try {
      write();
      return true;
    } catch {
      return false;
    }
  };

  it('refuses every write, at the top level and inside', () => {
    const tables = [ADJACENCY, MILLS, LINES_THROUGH, POINTS] as const;
    for (const table of tables) {
      expect(Object.isFrozen(table)).toBe(true);
      expect(written(() => (table as unknown as number[])[0] = 99)).toBe(false);
    }
    for (const row of [...ADJACENCY, ...MILLS, ...LINES_THROUGH]) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(written(() => (row as unknown as number[]).push(99))).toBe(false);
    }
  });

  it('hands out frozen lines from millsThrough', () => {
    const board = Array<Cell>(POINT_COUNT).fill(null);
    for (const p of MILLS[0]) board[p] = 'W';
    const [line] = millsThrough(board, MILLS[0][1], 'W');
    expect(written(() => ((line as unknown as number[])[2] = 23))).toBe(false);
    // The rules survive the attempt.
    expect(formsMill(board, MILLS[0][1], 'W')).toBe(true);
  });
});
