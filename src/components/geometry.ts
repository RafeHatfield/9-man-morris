/**
 * Where the engine's 24 points sit on screen (GDD §4.1 diagram, §6.1 sizing).
 *
 * The engine owns what the points *mean* (adjacency, the 16 mill lines); this
 * file owns only where they are drawn. `geometry.test.ts` checks the two agree.
 *
 * Points live on a 6×6 lattice, x to the right, y down:
 *
 *   (0,0)-------(3,0)-------(6,0)          0-----------1-----------2
 *     |           |           |            |           |           |
 *     |  (1,1)---(3,1)---(5,1)|            |   8-------9------10   |
 *     |    |       |       |  |            |   |       |       |   |
 *     |    | (2,2)(3,2)(4,2)  |            |   |  16--17--18   |   |
 *   (0,3)(1,3)(2,3)     (4,3)(5,3)(6,3)    7--15--23      19--11---3
 *     |    | (2,4)(3,4)(4,4)  |            |   |  22--21--20   |   |
 *     |    |       |       |  |            |   |       |       |   |
 *     |  (1,5)---(3,5)---(5,5)|            |  14------13------12   |
 *     |           |           |            |           |           |
 *   (0,6)-------(3,6)-------(6,6)          6-----------5-----------4
 *
 * Outer ring on the square's corners and side midpoints; middle ring inset by
 * one lattice unit; inner ring inset by two. There is no centre point.
 */

import { MILLS } from '@/lib/engine';

/** Lattice coordinate of a point: 0–6 on each axis. */
export interface GridPoint {
  readonly gx: number;
  readonly gy: number;
}

/** Pixel-space (viewBox unit) coordinate of a point. */
export interface ViewPoint {
  readonly x: number;
  readonly y: number;
}

/** The board SVG is `0 0 100 100`; everything below is in those units. */
export const VIEWBOX = 100;

/** Blank border inside the viewBox, so edge pieces and rings are not clipped. */
export const PADDING = 8;

/** One lattice unit in viewBox units: (100 − 2×8) / 6 = 14. */
export const STEP = (VIEWBOX - 2 * PADDING) / 6;

/**
 * Hit targets (GDD §6.2, ≥ 44 × 44 px at a 360 px viewport).
 *
 *   board width = min(360 − 2×16, 520) = 328 px          (§6.1: 16 px margin, max 520)
 *   1 viewBox unit = 328 / 100 = 3.28 px
 *   tap box = STEP = 14 units = 14 × 3.28 = 45.92 px     ≥ 44 ✓
 *
 * STEP is also the smallest distance between two points (the inner ring's
 * spacing), so the tap squares tile the board without overlapping — which is
 * also why they cannot simply be made bigger. That is the invariant
 * `geometry.test.ts` checks; the 44 px floor itself is measured on the real
 * rendered boxes by `e2e/mobile.spec.ts`, at both viewports.
 */
export const TAP_SIZE = STEP;

/**
 * The tap button's corner rounding, applied by `Board.tsx`.
 *
 * It must stay square. A browser hit-tests a `border-radius` button by its
 * rounded shape, not its box, so a `rounded-full` tap target of the same 45.92 px
 * box only accepts clicks inside its inscribed circle — a usable square of
 * 45.92 / √2 = 32.47 px, well under the 44 px §6.2 asks for. The corners are
 * exactly where a thumb lands when it misses the centre.
 */
export const TAP_SHAPE_CLASS = 'rounded-none';

/**
 * The page's layout numbers (GDD §6.1): the board fills the width with a 16 px
 * margin and is capped at 520 px, inside a page centred at 640 px on desktop.
 *
 * These are not a description of the CSS — they *are* the CSS. `Board.tsx` sets
 * its `maxWidth` from `BOARD_MAX_PX`, and the pages set their padding and
 * `maxWidth` from `BOARD_MARGIN_PX` and `PAGE_MAX_PX`. Change one and the board
 * changes width, which changes the tap targets: `e2e/mobile.spec.ts` measures
 * every one of the 24 rendered boxes against §6.2's 44 px, so a margin widened
 * here fails there rather than silently shrinking the targets.
 */
export const BOARD_MARGIN_PX = 16;
export const BOARD_MAX_PX = 520;
export const PAGE_MAX_PX = 640;

/** Lattice coordinates, indexed by the engine's point number. */
export const GRID_POINTS: readonly GridPoint[] = [
  // Outer ring 0–7, clockwise from top-left, on the square's corners and midpoints.
  { gx: 0, gy: 0 }, //  0
  { gx: 3, gy: 0 }, //  1
  { gx: 6, gy: 0 }, //  2
  { gx: 6, gy: 3 }, //  3
  { gx: 6, gy: 6 }, //  4
  { gx: 3, gy: 6 }, //  5
  { gx: 0, gy: 6 }, //  6
  { gx: 0, gy: 3 }, //  7
  // Middle ring 8–15, inset by one.
  { gx: 1, gy: 1 }, //  8
  { gx: 3, gy: 1 }, //  9
  { gx: 5, gy: 1 }, // 10
  { gx: 5, gy: 3 }, // 11
  { gx: 5, gy: 5 }, // 12
  { gx: 3, gy: 5 }, // 13
  { gx: 1, gy: 5 }, // 14
  { gx: 1, gy: 3 }, // 15
  // Inner ring 16–23, inset by two.
  { gx: 2, gy: 2 }, // 16
  { gx: 3, gy: 2 }, // 17
  { gx: 4, gy: 2 }, // 18
  { gx: 4, gy: 3 }, // 19
  { gx: 4, gy: 4 }, // 20
  { gx: 3, gy: 4 }, // 21
  { gx: 2, gy: 4 }, // 22
  { gx: 2, gy: 3 }, // 23
];

/** Lattice unit → viewBox unit. */
export function toView(g: number): number {
  return PADDING + g * STEP;
}

/** Draw positions, indexed by point number. */
export const POINT_XY: readonly ViewPoint[] = GRID_POINTS.map(({ gx, gy }) => ({
  x: toView(gx),
  y: toView(gy),
}));

/**
 * The lines to draw: exactly the engine's 16 mill lines, each rendered as the
 * segment from its first point to its last (the middle point is collinear, see
 * `geometry.test.ts`). Drawing anything else would let the picture drift from
 * the rules.
 */
export const SEGMENTS: readonly { readonly a: ViewPoint; readonly b: ViewPoint }[] =
  MILLS.map((mill) => ({ a: POINT_XY[mill[0]], b: POINT_XY[mill[2]] }));
