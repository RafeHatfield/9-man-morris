/**
 * Board topology (GDD §4.1). Hard-coded tables, asserted by `board.test.ts`.
 *
 * Points are indexed 0–23: outer ring 0–7, middle 8–15, inner 16–23, each ring
 * clockwise from its top-left corner. Odd indices are the side midpoints, which
 * are the only points the spokes join.
 *
 *     0-----------1-----------2
 *     |           |           |
 *     |   8-------9------10   |
 *     |   |       |       |   |
 *     |   |  16--17--18   |   |
 *     |   |   |       |   |   |
 *     7--15--23      19--11---3
 *     |   |   |       |   |   |
 *     |   |  22--21--20   |   |
 *     |   |       |       |   |
 *     |  14------13------12   |
 *     |           |           |
 *     6-----------5-----------4
 */

export const POINT_COUNT = 24;

export const POINTS: readonly number[] = Array.from(
  { length: POINT_COUNT },
  (_, i) => i,
);

/** Points one slide away: the three ring cycles plus the four spokes. */
export const ADJACENCY: readonly (readonly number[])[] = [
  /*  0 */ [1, 7],
  /*  1 */ [0, 2, 9],
  /*  2 */ [1, 3],
  /*  3 */ [2, 4, 11],
  /*  4 */ [3, 5],
  /*  5 */ [4, 6, 13],
  /*  6 */ [5, 7],
  /*  7 */ [0, 6, 15],
  /*  8 */ [9, 15],
  /*  9 */ [1, 8, 10, 17],
  /* 10 */ [9, 11],
  /* 11 */ [3, 10, 12, 19],
  /* 12 */ [11, 13],
  /* 13 */ [5, 12, 14, 21],
  /* 14 */ [13, 15],
  /* 15 */ [7, 8, 14, 23],
  /* 16 */ [17, 23],
  /* 17 */ [9, 16, 18],
  /* 18 */ [17, 19],
  /* 19 */ [11, 18, 20],
  /* 20 */ [19, 21],
  /* 21 */ [13, 20, 22],
  /* 22 */ [21, 23],
  /* 23 */ [15, 16, 22],
];

/** The 16 mill lines: four per ring, plus the four spokes. */
export const MILLS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [2, 3, 4],
  [4, 5, 6],
  [6, 7, 0],
  [8, 9, 10],
  [10, 11, 12],
  [12, 13, 14],
  [14, 15, 8],
  [16, 17, 18],
  [18, 19, 20],
  [20, 21, 22],
  [22, 23, 16],
  [1, 9, 17],
  [3, 11, 19],
  [5, 13, 21],
  [7, 15, 23],
];

/** The two mill lines through each point, derived from MILLS so it cannot drift. */
export const LINES_THROUGH: readonly (readonly (readonly [
  number,
  number,
  number,
])[])[] = POINTS.map((point) => MILLS.filter((mill) => mill.includes(point)));

// These tables are the rules. `millsThrough` hands lines straight out of
// `LINES_THROUGH` to the UI, so freeze them: a caller that casts away `readonly`
// must not be able to rewrite the game for the rest of the process.
for (const neighbours of ADJACENCY) Object.freeze(neighbours);
for (const mill of MILLS) Object.freeze(mill);
for (const lines of LINES_THROUGH) Object.freeze(lines);
Object.freeze(ADJACENCY);
Object.freeze(MILLS);
Object.freeze(LINES_THROUGH);
Object.freeze(POINTS);
