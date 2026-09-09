/**
 * The wire contract between the client and the server (GDD §7.3).
 *
 * The server is the only authority: the client sends an intent plus the version
 * it thinks it is acting on, and adopts whatever comes back. Nothing here ever
 * carries a player token belonging to someone else — see `publicRoom`.
 */

import type { GameState, Player } from '@/lib/engine';
import type { Room } from '@/lib/store';

/** Everything a client may see about a room, whoever they are (GDD §7.3). */
export interface PublicRoom {
  id: string;
  version: number;
  game: GameState;
  timerMs: number | null;
  /** Epoch ms the current turn started; the clock is server-authoritative (§5.3). */
  turnStartedAt: number;
  /** Epoch ms on the server, so a client with a skewed clock still counts down correctly. */
  serverNow: number;
  /** Which seats are taken. Tokens are never sent. */
  seats: { W: boolean; B: boolean };
  /**
   * Whether the per-turn clock is actually running: both seats filled, a timer
   * chosen, and the game still live. The §5.3 countdown may only be drawn when
   * this is true — until an opponent joins, `turnStartedAt` is a placeholder the
   * server will restamp at the join, and every move and claim is refused.
   */
  clockRunning: boolean;
  rematch: { W: boolean; B: boolean };
  drawOffer: { W: boolean; B: boolean };
  /**
   * Increments on rematch. A client that sends it back on
   * `POST /api/game/[id]/draw` pins that tap to this game: the offer or the
   * acceptance is refused with a 409 if the room has moved on to another one.
   * That endpoint also takes `accepting`, which pins the tap to the offer the
   * button was drawn from — see `drawSchema`.
   */
  gameNumber: number;
}

/** The one place a `Room` is narrowed for the wire. Tokens must not escape it. */
export function publicRoom(room: Room, now: number): PublicRoom {
  return {
    id: room.id,
    version: room.version,
    game: room.game,
    timerMs: room.timerMs,
    turnStartedAt: room.turnStartedAt,
    serverNow: now,
    seats: { W: room.players.W !== null, B: room.players.B !== null },
    clockRunning:
      room.players.W !== null &&
      room.players.B !== null &&
      room.timerMs !== null &&
      room.game.result === null,
    rematch: room.rematch,
    drawOffer: room.drawOffer,
    gameNumber: room.gameNumber,
  };
}

/** `POST /api/game` — creates a room; the creator is White in game 1 (GDD §5.1). */
export interface CreateGameResponse {
  roomId: string;
  token: string;
  colour: Player;
  room: PublicRoom;
}

/** `POST /api/game/[id]/join` — claims the free seat, or 409 if the room is full. */
export interface JoinResponse {
  token: string;
  colour: Player;
  room: PublicRoom;
}

/**
 * Every failure the route handlers send carries this shape, so the client has
 * one thing to read — a store failure this layer does not recognise included,
 * which becomes a 500 with an `error` and nothing else. (A request for a method
 * no route implements is answered by the framework, not by this code: a 405
 * with an empty body, a 204 for a preflight, or a plain-text 500 for `TRACE`.
 * Nothing this app sends is such a request.)
 *
 * `room` is present on every refusal the server made *about a room it had
 * loaded* — the 403s, the 409s, and the 400 the engine raises for an illegal
 * action. It is absent on three: a 404, where there is no room; the 400 a
 * malformed body earns, answered before any room is read; and the 500 for a
 * failure this layer does not recognise, where the safe answer carries nothing
 * but `error`.
 *
 * A 409 means the room moved on, *not* that the board did: an opponent's draw
 * offer or rematch tap bumps `version` too. The client adopts `room` and, if it
 * still wants to, re-sends its action pinned to the version it just learned.
 */
export interface ApiError {
  error: string;
  /** The current view, when the server has one worth adopting (e.g. on a 409). */
  room?: PublicRoom;
}

/** The turn timers offered at creation (GDD §5.3). `null` is "None". */
export const TIMER_CHOICES: readonly (number | null)[] = [
  null,
  60_000,
  300_000,
  86_400_000,
];

export const DEFAULT_TIMER_MS = 300_000;
