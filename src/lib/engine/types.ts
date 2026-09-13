/** Game types, exactly as specified in GDD §7.1. */

/**
 * The three closed alphabets, as runtime values. The types below are derived from
 * them, so there is one definition of each rather than a list and a union that
 * can drift — and anything outside the engine that has to check a value against
 * one of them (the store, validating a room read back from Redis) imports the
 * list instead of restating the literals. Frozen, like the board tables.
 */
export const PLAYERS = Object.freeze(['W', 'B'] as const);
export const PHASES = Object.freeze(['placing', 'moving', 'over'] as const);
export const REASONS = Object.freeze([
  'millout',
  'blocked',
  'forfeit',
  'resign',
  'draw50',
  'drawagreed',
] as const);

export type Player = (typeof PLAYERS)[number];
export type Cell = Player | null;
export type Phase = (typeof PHASES)[number];
export type Reason = (typeof REASONS)[number];

export interface Result {
  /** null on a draw. */
  winner: Player | null;
  reason: Reason;
}

export interface GameState {
  /** One cell per point, indexed 0–23 (GDD §4.1). */
  board: Cell[];
  hand: { W: number; B: number };
  turn: Player;
  phase: Phase;
  /** True between forming a mill and removing a piece; the turn does not pass until it clears. */
  pendingRemoval: boolean;
  /** Movement-phase moves since the last removal, for the 50-move draw. */
  movesSinceRemoval: number;
  lastMove: { from: number | null; to: number } | null;
  result: Result | null;
}

export type Action =
  | { type: 'place'; point: number }
  | { type: 'move'; from: number; to: number }
  | { type: 'remove'; point: number }
  | { type: 'resign' }
  | { type: 'forfeit'; player: Player };
