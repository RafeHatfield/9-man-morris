/**
 * The drawing coordinates and the engine's topology must describe the same
 * board. These tests fail if either table is wrong — a mis-typed coordinate
 * breaks collinearity or spacing, a mis-typed adjacency breaks the two-way
 * neighbour check.
 */

import { describe, expect, it } from 'vitest';
import { ADJACENCY, MILLS, POINT_COUNT } from '@/lib/engine';
import {
  GRID_POINTS,
  PADDING,
  POINT_XY,
  SEGMENTS,
  STEP,
  TAP_SIZE,
  toView,
} from './geometry';

/** Points of a mill line, ordered along the line. */
function ordered(mill: readonly [number, number, number]) {
  return [...mill]
    .map((i) => ({ i, ...GRID_POINTS[i] }))
    .sort((a, b) => a.gx - b.gx || a.gy - b.gy);
}

/** Is a point strictly inside the axis-aligned segment a→b? */
function isBetween(a: number, b: number, c: number): boolean {
  return c > Math.min(a, b) && c < Math.max(a, b);
}

/**
 * Two points are neighbours *in the picture* when a drawn mill line covers both
 * and no third point lies between them. The board's empty centre is not a point,
 * and no drawn line crosses it, so 17–21 and 23–19 are correctly not neighbours.
 */
function pictureNeighbours(): Set<string> {
  const pairs = new Set<string>();
  for (const mill of MILLS) {
    const [p, q, r] = ordered(mill);
    pairs.add(key(p.i, q.i));
    pairs.add(key(q.i, r.i));
  }
  return pairs;
}

function key(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

describe('point coordinates', () => {
  it('has one coordinate per engine point', () => {
    expect(GRID_POINTS).toHaveLength(POINT_COUNT);
    expect(POINT_XY).toHaveLength(POINT_COUNT);
  });

  it('gives all 24 points distinct coordinates', () => {
    const seen = new Set(GRID_POINTS.map((g) => `${g.gx},${g.gy}`));
    expect(seen.size).toBe(POINT_COUNT);
  });

  it('keeps every point on the 6×6 lattice', () => {
    for (const { gx, gy } of GRID_POINTS) {
      expect(Number.isInteger(gx)).toBe(true);
      expect(Number.isInteger(gy)).toBe(true);
      expect(gx).toBeGreaterThanOrEqual(0);
      expect(gx).toBeLessThanOrEqual(6);
      expect(gy).toBeGreaterThanOrEqual(0);
      expect(gy).toBeLessThanOrEqual(6);
    }
  });

  it('leaves the centre of the board empty', () => {
    expect(GRID_POINTS.some((g) => g.gx === 3 && g.gy === 3)).toBe(false);
  });

  it('projects the lattice into the viewBox', () => {
    GRID_POINTS.forEach(({ gx, gy }, i) => {
      expect(POINT_XY[i].x).toBeCloseTo(PADDING + gx * STEP, 10);
      expect(POINT_XY[i].y).toBeCloseTo(PADDING + gy * STEP, 10);
    });
  });

  it('keeps the board inside the viewBox', () => {
    expect(toView(0)).toBe(PADDING);
    expect(toView(6)).toBe(100 - PADDING);
  });
});

describe('mill lines', () => {
  it.each(MILLS.map((mill, i) => [i, mill] as const))(
    'mill %i %j is collinear and evenly spaced',
    (_i, mill) => {
      const [p, q, r] = ordered(mill);
      const sameRow = p.gy === q.gy && q.gy === r.gy;
      const sameCol = p.gx === q.gx && q.gx === r.gx;
      expect(sameRow || sameCol).toBe(true);

      const axis = sameRow ? 'gx' : 'gy';
      expect(q[axis] - p[axis]).toBe(r[axis] - q[axis]);
      expect(q[axis] - p[axis]).toBeGreaterThan(0);
    },
  );

  it('draws one segment per mill, through its middle point', () => {
    expect(SEGMENTS).toHaveLength(MILLS.length);
    SEGMENTS.forEach((seg, i) => {
      const mill = MILLS[i];
      const mid = POINT_XY[mill[1]];
      expect(seg.a).toEqual(POINT_XY[mill[0]]);
      expect(seg.b).toEqual(POINT_XY[mill[2]]);
      // Horizontal or vertical, with the middle point on it.
      const horizontal = seg.a.y === seg.b.y;
      if (horizontal) {
        expect(mid.y).toBe(seg.a.y);
        expect(isBetween(seg.a.x, seg.b.x, mid.x)).toBe(true);
      } else {
        expect(seg.a.x).toBe(seg.b.x);
        expect(mid.x).toBe(seg.a.x);
        expect(isBetween(seg.a.y, seg.b.y, mid.y)).toBe(true);
      }
    });
  });
});

describe('adjacency matches the drawing', () => {
  it.each(
    ADJACENCY.flatMap((ns, from) =>
      ns.filter((to) => to > from).map((to) => [from, to] as const),
    ),
  )('%i–%i is a clear horizontal or vertical segment', (from, to) => {
    const a = GRID_POINTS[from];
    const b = GRID_POINTS[to];
    expect(a.gx === b.gx || a.gy === b.gy).toBe(true);

    const blocking = GRID_POINTS.filter((c, i) => {
      if (i === from || i === to) return false;
      if (a.gx === b.gx) return c.gx === a.gx && isBetween(a.gy, b.gy, c.gy);
      return c.gy === a.gy && isBetween(a.gx, b.gx, c.gx);
    });
    expect(blocking).toEqual([]);
  });

  it('is exactly the set of neighbouring pairs in the picture', () => {
    const engine = new Set(
      ADJACENCY.flatMap((ns, from) =>
        ns.filter((to) => to > from).map((to) => key(from, to)),
      ),
    );
    const drawn = pictureNeighbours();
    expect([...engine].sort()).toEqual([...drawn].sort());
    expect(engine.size).toBe(32);
  });

  it('is symmetric in the engine', () => {
    ADJACENCY.forEach((ns, from) => {
      for (const to of ns) expect(ADJACENCY[to]).toContain(from);
    });
  });
});

describe('hit targets (GDD §6.2)', () => {
  it('never overlaps its neighbour: the tap square is one lattice step', () => {
    // The whole §6.2 hit-target story is two halves. This is the half a unit
    // test can own: the tap square is exactly one lattice step, so the 24
    // squares tile the board and none of them can be made bigger without
    // stealing from its neighbour. The other half — that one step is at least
    // 44 px once the board is actually laid out — is measured on the rendered
    // boxes by `e2e/mobile.spec.ts`, on all 24 points at both viewports.
    expect(TAP_SIZE).toBe(STEP);
    const gaps = ADJACENCY.flatMap((ns, from) =>
      ns.map((to) =>
        Math.abs(POINT_XY[from].x - POINT_XY[to].x) +
        Math.abs(POINT_XY[from].y - POINT_XY[to].y),
      ),
    );
    expect(Math.min(...gaps)).toBeCloseTo(TAP_SIZE, 10);
  });
});
