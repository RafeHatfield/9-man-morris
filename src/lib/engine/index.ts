/**
 * The engine's public surface: GDD §7.1's five functions and its types, plus the
 * board tables and helpers the rest of the app actually imports.
 *
 * `POINTS`, `LINES_THROUGH` and `DRAW_MOVE_LIMIT` are exported from their own
 * modules — which is how the engine's own tests reach them — and deliberately not
 * re-exported here, because nothing outside imports them. `Result` is left off for
 * the same reason: nothing outside names it, and `GameState.result` carries the
 * shape structurally. `PIECES_PER_PLAYER` and `isOver` are not exported from
 * anywhere at all; their only callers sit in the files that define them.
 *
 * So this file is a list of what the app depends on rather than of what happens
 * to be `export`ed somewhere below.
 */

// GDD §4.1's topology. `MILLS` draws the board; the store checks a stored board's
// length against `POINT_COUNT`; `ADJACENCY` is what the board's geometry test
// asserts the drawn neighbours against.
export { ADJACENCY, MILLS, POINT_COUNT } from './board';

// GDD §7.1's five, plus: `millsThrough` (the UI flashes a formed mill, and one
// move can form two), `agreeDraw` (§4.6's agreed draw, which §7.1's `Action` union
// has no member for), `opponentOf` (the UI names the other player),
// `IllegalActionError` (the API tells an illegal move from a server fault).
export {
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

// The closed alphabets are runtime lists so the store can check membership
// without restating the literals; the types below are derived from them.
export { PHASES, PLAYERS, REASONS } from './types';
export type {
  Action,
  Cell,
  GameState,
  Phase,
  Player,
  Reason,
} from './types';
