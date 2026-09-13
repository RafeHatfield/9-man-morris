/**
 * The client half of the wire contract (GDD §7.3). One `fetch` per endpoint,
 * with the failure shape the API actually sends (`ApiError`), so no caller has
 * to know how a refusal is spelled.
 *
 * Nothing here interprets a failure: the server is the authority, every refusal
 * carries the room as it really is, and the caller adopts that and re-renders
 * (§7.3). There are no error toasts anywhere in this app (§6.2).
 */

import type {
  ApiError,
  CreateGameResponse,
  JoinResponse,
  PublicRoom,
} from '@/lib/api/types';
import {
  PHASES,
  PLAYERS,
  POINT_COUNT,
  REASONS,
  type Action,
  type Cell,
  type GameState,
  type Phase,
  type Player,
} from '@/lib/engine';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; room?: PublicRoom };

/**
 * How long a request may be outstanding before it is abandoned.
 *
 * A browser does not time `fetch` out on its own: a request to a host that
 * accepts the connection and then says nothing can hang for minutes. One of
 * those is enough to stop this client dead, because the poll and the mutations
 * both run one-at-a-time (`SingleFlight`) and a promise that never settles
 * never releases the gate. Eight seconds is more than five polls; anything
 * still outstanding is not coming back, and the next poll will ask again.
 */
export const REQUEST_TIMEOUT_MS = 8_000;

/**
 * The one place a response is turned into a result.
 *
 * Two rules, one on each side of the door, and they are the same rule: **this
 * client acts on a reply only when the reply is this server's.** A 2xx is a
 * success only if the body is the response type that was asked for; a refusal is
 * believed — its status acted on, its room adopted — only if it arrives in this
 * server's own error envelope, with a room that is a room. Anything else is
 * something between us and the server talking (a captive portal, a proxy, an
 * edge error page, a body cut off after its headers), and is reported as an
 * unattributable failure that no caller acts on beyond trying again.
 */
async function send<T>(
  url: string,
  /** The room this request is about, or `null` for the one that makes rooms. */
  roomId: string | null,
  isExpected: Check<T>,
  init?: { method: 'POST'; body: unknown },
): Promise<ApiResult<T>> {
  // Everything below is inside one guarded region, because a `send` that throws
  // breaks the promise every caller here relies on — they all run it through a
  // `SingleFlight` with `void`, where a rejection is unhandled and the gate is
  // all that notices. That includes *building* the request: `AbortSignal.timeout`
  // is not on iOS Safari before 16, so the timeout is an `AbortController` and a
  // timer, constructed in here rather than outside. The timer covers the body as
  // well as the headers — a response whose headers arrive and whose body never
  // does is exactly the hang it exists for.
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const request: RequestInit = {
      cache: 'no-store',
      signal: controller.signal,
      ...(init === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(init.body),
          }),
    };

    const response = await fetch(url, request);

    let body: unknown;
    let readable = true;
    try {
      body = await response.json();
    } catch {
      readable = false;
    }

    // A 2xx is not a success unless what came back is the thing that was asked
    // for. An unreadable body — an intermediary's HTML error page, a captive
    // portal, or a body cut off after the headers arrived — parses as nothing;
    // a readable one may still be somebody else's JSON. Either way it must not
    // reach `adopt`, where the first thing that happens is a field read.
    if (response.ok) {
      // Narrowed by `isExpected`, so `data` is not a cast.
      return readable && isExpected(body)
        ? { ok: true, data: body }
        : UNATTRIBUTABLE;
    }

    // A status is only ever believed together with this server's envelope. That
    // matters most for 404: `useRoom` reads it as "the room is gone", which stops
    // the polling for good, and an edge 404 or a mid-redeploy has exactly the
    // shape of one. The room is checked the same way the success path is checked
    // — it is dereferenced by `adopt`, `canRepin` and `seatIsRefused` — and is
    // simply dropped if it is not one, which leaves the caller to re-read.
    if (!readable || !isApiError(body)) return UNATTRIBUTABLE;
    return {
      ok: false,
      status: response.status,
      error: body.error,
      // Checked exactly as the success body is — including whose room it is.
      room: isRoomFor(roomId)(body.room) ? body.room : undefined,
    };
  } catch {
    // Offline, cut off, timed out — or a browser that would not build the
    // request at all. Every one of them is a result, never a throw.
    return { ok: false, status: 0, error: 'network error' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A reply this client cannot attribute to its own server. Status 0, like a dead
 * network, because that is what it is: nothing was heard from the server, and no
 * status came back that anything here may act on.
 */
const UNATTRIBUTABLE = {
  ok: false as const,
  status: 0,
  error: 'the reply did not come from this game',
};

// — what a reply has to look like ——————————————————————————————————————
//
// Not Zod, and not a hand-kept list either: one checker per declared field,
// collected in a mapped type. Add a field to `PublicRoom` or `GameState` and the
// record below stops compiling; give a field a checker for the wrong type and
// the two do not line up. That is what keeps this from drifting away from the
// fields the client actually reads, which is how `result` went missing the first
// time this was written by hand.
//
// It still checks *shape*, never legality: whether a position is reachable is
// the engine's business and the store's, not the wire's.

type Check<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Every field of `T` has a checker, and each one checks that field's type. */
function hasShape<T>(
  value: unknown,
  fields: Record<string, (field: unknown) => boolean>,
): value is T {
  if (!isRecord(value)) return false;
  for (const [name, check] of Object.entries(fields)) {
    if (!check(value[name])) return false;
  }
  return true;
}

/** Membership in one of the engine's closed alphabets, which it exports as lists. */
function isOneOf(alphabet: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && alphabet.includes(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTimerMs(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isPlayer(value: unknown): value is Player {
  return isOneOf(PLAYERS, value);
}

function isPhase(value: unknown): value is Phase {
  return isOneOf(PHASES, value);
}

function isCell(value: unknown): value is Cell {
  return value === null || isPlayer(value);
}

function isBoard(value: unknown): value is Cell[] {
  return (
    Array.isArray(value) && value.length === POINT_COUNT && value.every(isCell)
  );
}

function isCounts(value: unknown): value is { W: number; B: number } {
  return isRecord(value) && isNumber(value.W) && isNumber(value.B);
}

function isFlagPair(value: unknown): value is { W: boolean; B: boolean } {
  return isRecord(value) && isBoolean(value.W) && isBoolean(value.B);
}

function isLastMove(
  value: unknown,
): value is { from: number | null; to: number } | null {
  return (
    value === null ||
    (isRecord(value) &&
      (value.from === null || isNumber(value.from)) &&
      isNumber(value.to))
  );
}

function isResult(value: unknown): value is GameState['result'] {
  return (
    value === null ||
    (isRecord(value) &&
      (value.winner === null || isPlayer(value.winner)) &&
      isOneOf(REASONS, value.reason))
  );
}

const GAME_FIELDS: { [K in keyof GameState]-?: Check<GameState[K]> } = {
  board: isBoard,
  hand: isCounts,
  turn: isPlayer,
  phase: isPhase,
  pendingRemoval: isBoolean,
  movesSinceRemoval: isNumber,
  lastMove: isLastMove,
  result: isResult,
};

function isGameState(value: unknown): value is GameState {
  return hasShape<GameState>(value, GAME_FIELDS);
}

const PUBLIC_ROOM_FIELDS: { [K in keyof PublicRoom]-?: Check<PublicRoom[K]> } = {
  id: isString,
  version: isNumber,
  game: isGameState,
  timerMs: isTimerMs,
  turnStartedAt: isNumber,
  serverNow: isNumber,
  seats: isFlagPair,
  clockRunning: isBoolean,
  rematch: isFlagPair,
  drawOffer: isFlagPair,
  gameNumber: isNumber,
};

/** Everything `PublicRoom` promises (GDD §7.3), field by declared field. */
function isPublicRoom(value: unknown): value is PublicRoom {
  return hasShape<PublicRoom>(value, PUBLIC_ROOM_FIELDS);
}

/**
 * A room, *and* the room this request was about.
 *
 * Every caller has the id in hand, so nothing here has to accept a room it did
 * not ask for. A well-formed reply belonging to another room is the worst kind
 * of wrong answer: it draws a stranger's board and reports a stranger's turn,
 * and because a room's `version` only climbs, a higher one from elsewhere makes
 * `adoptRoom` reject every genuine poll that follows — the tab never recovers.
 * The same body arriving on a 409 or a 403 takes the same path, so the refusal
 * side is checked here too.
 */
function isRoomFor(id: string | null): Check<PublicRoom> {
  return (value): value is PublicRoom =>
    isPublicRoom(value) && (id === null || value.id === id);
}

/** The envelope every refusal from this server arrives in. */
function isApiError(value: unknown): value is ApiError {
  return isRecord(value) && isString(value.error);
}

function seatFields(id: string): {
  [K in keyof JoinResponse]-?: Check<JoinResponse[K]>;
} {
  return { token: isNonEmptyString, colour: isPlayer, room: isRoomFor(id) };
}

/** `POST …/join` — the token is written to `localStorage` unread (§5.1). */
function isJoinResponse(id: string): Check<JoinResponse> {
  return (value): value is JoinResponse =>
    hasShape<JoinResponse>(value, seatFields(id));
}

/**
 * `POST /api/game` — the same, plus the id the client is about to navigate to.
 * There is no id to compare against yet, so the check is that the reply agrees
 * with itself: the room it hands back is the room it names.
 */
function isCreateGameResponse(value: unknown): value is CreateGameResponse {
  if (!isRecord(value) || !isNonEmptyString(value.roomId)) return false;
  const fields: {
    [K in keyof CreateGameResponse]-?: Check<CreateGameResponse[K]>;
  } = { ...seatFields(value.roomId), roomId: isNonEmptyString };
  return hasShape<CreateGameResponse>(value, fields);
}

const room = (id: string) => `/api/game/${encodeURIComponent(id)}`;

/** `POST /api/game` — creates a room; this client is White in game 1 (§5.1). */
export function createGame(
  timerMs: number | null,
): Promise<ApiResult<CreateGameResponse>> {
  return send<CreateGameResponse>('/api/game', null, isCreateGameResponse, {
    method: 'POST',
    body: { timerMs },
  });
}

/** `GET /api/game/[id]` — what the clients poll, and what a visitor sees. */
export function fetchRoom(id: string): Promise<ApiResult<PublicRoom>> {
  return send<PublicRoom>(room(id), id, isRoomFor(id));
}

/** `POST …/join` — claims the free seat, or 409 if there is none (§5.1). */
export function joinRoom(id: string): Promise<ApiResult<JoinResponse>> {
  return send<JoinResponse>(`${room(id)}/join`, id, isJoinResponse(id), {
    method: 'POST',
    body: {},
  });
}

/** `POST …/action` — the only thing that moves a piece (§7.3). */
export function sendAction(
  id: string,
  token: string,
  action: Action,
  expectedVersion: number,
): Promise<ApiResult<PublicRoom>> {
  return send<PublicRoom>(`${room(id)}/action`, id, isRoomFor(id), {
    method: 'POST',
    body: { token, action, expectedVersion },
  });
}

/**
 * How many times a resignation re-pins itself to the version the server names.
 * Three, like `mutateRoom`'s own retry for the endpoints that carry no version.
 */
const RESIGN_ATTEMPTS = 3;

/**
 * A 409 this resignation may re-pin itself to: the same game, still unfinished,
 * and refused for the version rather than for the room's state.
 *
 * Both extra conditions are load-bearing. **The same game**: a rematch makes a
 * fresh game at the same URL with the colours swapped (§5.4), so re-sending into
 * it would resign a game this player has never seen — possibly as the other
 * colour. **A version conflict, not a state refusal**: `mutateRoom` resolves the
 * room and the seat first — 404 for a room it cannot find, 403 for a token with
 * no seat — and compares the version next, ahead of the turn, the clock and the
 * action the mutation judges (`seatRefusal.ts` states the same order, for the
 * 403 that comes out of it). So a 409 always names a version that has moved, while "the game is
 * over" or "waiting for an opponent" come out of the mutation and leave it
 * alone. Re-sending those is a byte-identical repeat of a request the server
 * has already refused.
 */
function canRepin(
  result: ApiResult<PublicRoom>,
  sentVersion: number,
  from: PublicRoom,
): result is { ok: false; status: number; error: string; room: PublicRoom } {
  return (
    !result.ok &&
    result.status === 409 &&
    result.room !== undefined &&
    result.room.version !== sentVersion &&
    result.room.gameNumber === from.gameNumber &&
    result.room.game.result === null
  );
}

/**
 * `POST …/action` with `{type: 'resign'}` (§4.6), re-pinned and re-sent on a
 * version conflict rather than lost.
 *
 * Every other action is judged against the position it was drawn from, so a 409
 * means the board moved and the tap is dropped (§6.2) — the board is inert until
 * the poll lands, so nothing was aimed at the stale position anyway. A
 * resignation is not about the position: it is legal at every version and from
 * either seat, and the moment a player decides to resign is exactly the moment
 * an opponent's move is most likely to be in flight. `/draw`, `/rematch` and
 * `/claim-timeout` carry no version and are retried server-side for the same
 * reason; `/action` requires one, so the retry lives here. The 409 body carries
 * the room the server has, so the new version costs no extra request.
 *
 * @param from the room this resignation was decided in. Its version is what is
 *             sent first, and its `gameNumber` is what the retry is bounded by.
 */
export async function resignGame(
  id: string,
  token: string,
  from: PublicRoom,
): Promise<ApiResult<PublicRoom>> {
  let version = from.version;
  for (let attempt = 1; ; attempt++) {
    const result = await sendAction(id, token, { type: 'resign' }, version);
    if (result.ok || attempt >= RESIGN_ATTEMPTS) return result;
    if (!canRepin(result, version, from)) return result;
    version = result.room.version;
  }
}

/** `POST …/claim-timeout` — the opponent claims the win (§5.3). */
export function claimTimeout(
  id: string,
  token: string,
): Promise<ApiResult<PublicRoom>> {
  return send<PublicRoom>(`${room(id)}/claim-timeout`, id, isRoomFor(id), {
    method: 'POST',
    body: { token },
  });
}

/** `POST …/rematch` — offer and accept in one call (§5.4). */
export function offerRematch(
  id: string,
  token: string,
): Promise<ApiResult<PublicRoom>> {
  return send<PublicRoom>(`${room(id)}/rematch`, id, isRoomFor(id), {
    method: 'POST',
    body: { token },
  });
}

/**
 * `POST …/draw` — offer and accept in one call (§4.6).
 *
 * Which of the two a tap *is* depends on the room when it lands, and the label
 * the player read came from a room up to a poll old — or arbitrarily old in a
 * background tab, which does not poll at all (§7.3). So both things the player
 * was looking at travel with the tap and are judged inside the write, under the
 * same optimistic-concurrency guard as everything else:
 *
 * - `gameNumber` — which game it was about. A rematch makes a different game at
 *   the same URL, in which this token plays the other colour (§5.4).
 * - `accepting` — whether the player was answering an offer or making one. It is
 *   the same bit the button's label was chosen from, and the server compares it
 *   against the *opponent's* flag. One bit rather than the `drawOffer` pair,
 *   because the caller's own flag is not part of the decision — offering twice
 *   is already a no-op — so echoing the pair would refuse taps that are fine.
 *
 * That closes both directions: an offer that would land as an acceptance because
 * the opponent's offer arrived inside the request, and an acceptance that would
 * land as a fresh offer because theirs had lapsed. Neither can be settled here.
 * A read before the write narrowed that window to a round trip and could never
 * close it, so there is no read: the room is judged where it is written, and a
 * refusal is adopted and the tap dropped like any other (§6.2).
 *
 * @param from      the room the player was looking at when they tapped.
 * @param accepting what the button they tapped said it would do.
 */
export function offerDraw(
  id: string,
  token: string,
  from: PublicRoom,
  accepting: boolean,
): Promise<ApiResult<PublicRoom>> {
  return send<PublicRoom>(`${room(id)}/draw`, id, isRoomFor(id), {
    method: 'POST',
    body: { token, gameNumber: from.gameNumber, accepting },
  });
}
