/**
 * The room record and the store adapter over it (GDD §7.2, §7.4).
 *
 * A `Room` is everything the server knows about one game: the pure `GameState`
 * from the engine plus the things the engine deliberately does not hold — player
 * tokens, the clock, and the version used for optimistic concurrency.
 */

import { PHASES, PLAYERS, POINT_COUNT, REASONS } from '@/lib/engine';
import type { GameState } from '@/lib/engine';

/** GDD §7.4, exactly. */
export interface Room {
  id: string;
  version: number;
  createdAt: number;
  /** Player tokens. Never returned to clients. */
  players: { W: string | null; B: string | null };
  timerMs: number | null;
  turnStartedAt: number;
  game: GameState;
  rematch: { W: boolean; B: boolean };
  drawOffer: { W: boolean; B: boolean };
  /** Increments on rematch; parity decides who is White. */
  gameNumber: number;
}

/**
 * GDD §7.2.
 *
 * Both implementations share exactly two guarantees, and no more:
 *
 * 1. **Rooms are held by value.** What goes in is copied on the way in and on
 *    the way out, through a JSON round trip on both paths, so no caller can
 *    reach into the store through an object it handed over or got back.
 * 2. **`update` is a compare-and-set on `version`.** Of any number of `update`
 *    calls racing on one id from the same `expectedVersion`, exactly one wins;
 *    the rest get {@link VersionConflictError}.
 *
 * Anything beyond those two is not promised and must not be relied on.
 */
export interface RoomStore {
  get(id: string): Promise<Room | null>;
  /**
   * Create or replace the room at `id`, wholesale.
   *
   * `set` is **not** part of the optimistic-concurrency protocol: it writes
   * whatever `version` it is given and takes part in no compare-and-set. It is
   * for creating a room, where by definition nothing else can be mid-`update`
   * on that id. Everything after creation goes through {@link RoomStore.update}.
   *
   * Issuing a `set` concurrently with an `update` on the same id is a misuse.
   * Which of the two survives depends on what the `set` wrote, and both
   * implementations agree on both outcomes:
   *
   * - a `set` that **keeps** the version the `update` expected is invisible to
   *   the compare-and-set, so the `update` completes and the `set` is lost;
   * - a `set` that **moves** the version fails the compare-and-set, so the
   *   `update` throws {@link VersionConflictError} and the `set` survives.
   *
   * Both are pinned by tests over both implementations. Neither is a licence to
   * race them: which one you get depends on a `version` the racing `set` chose,
   * which is exactly the thing a caller racing a `set` is not thinking about.
   *
   * `room.id` must equal `id`. A room that disagrees with the key it is being
   * filed under is refused, not corrected — see {@link roomToJson} for why the
   * store refuses rather than rewrites its own fields.
   */
  set(id: string, room: Room): Promise<void>;
  /**
   * Read-modify-write under optimistic concurrency. `fn` receives the current
   * room and returns the next one; the store — not `fn` — owns `id` and
   * `version`, and always writes `id` and `expectedVersion + 1` whatever `fn`
   * returned for them.
   *
   * `fn` is handed a private copy: mutating it, or throwing after mutating it,
   * cannot reach the stored room.
   *
   * Throws {@link RoomNotFoundError} if the room is gone and
   * {@link VersionConflictError} if the stored version is not `expectedVersion`
   * — including when a competing `update` lands between this one's read and its
   * write. Throws {@link CorruptRoomError} if the stored JSON is not a room,
   * **including when it stops being one inside that same window** — the case the
   * compare-and-set exists for. `RedisStore` used to answer that one with a
   * plain `Error` from its script-result parser, or with whatever `cjson.decode`
   * raised, neither carrying `roomId` and neither one of the three types listed
   * here, while `MemoryStore` threw `CorruptRoomError`. These three are the only
   * types either implementation raises **of its own**. Two things pass through
   * unchanged: an exception of `fn`'s own, and anything the injected
   * `RedisClient` throws — `RedisStore.update` awaits `this.get` and
   * `this.client.eval` with no handler, so an Upstash outage, rate limit or
   * timeout reaches the caller as that client's own error (an `UpstashError`
   * from the real one). A transport failure is not a statement about the room,
   * and dressing one up as `CorruptRoomError` would say it was.
   */
  update(
    id: string,
    fn: (room: Room) => Room,
    expectedVersion: number,
  ): Promise<Room>;
}

/**
 * The room does not exist (never created, or expired). The API layer turns this
 * into a 404.
 */
export class RoomNotFoundError extends Error {
  readonly roomId: string;

  constructor(roomId: string) {
    super(`Room ${roomId} not found`);
    this.name = 'RoomNotFoundError';
    this.roomId = roomId;
  }
}

/**
 * The caller's `expectedVersion` is not the stored version — someone else moved
 * first. The API layer turns this into a 409 (GDD §7.3); the client re-reads and
 * adopts the server's state.
 */
export class VersionConflictError extends Error {
  readonly roomId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(roomId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Room ${roomId} is at version ${actualVersion}, not ${expectedVersion}`,
    );
    this.name = 'VersionConflictError';
    this.roomId = roomId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * A value that should be a room is not one: unparseable JSON, or JSON of the
 * wrong shape. Raised on the way *out* of Redis (something else wrote the key,
 * or a stored room predates a change to {@link Room}) and on the way *in* on
 * either implementation (a caller handed the store a room that would not survive
 * the JSON round trip — `NaN` becomes `null`, `undefined` fields vanish). The
 * API layer turns this into a 500: both are server faults, not client ones.
 */
export class CorruptRoomError extends Error {
  readonly roomId: string;

  constructor(roomId: string, detail: string) {
    super(`Room ${roomId} is not readable: ${detail}`);
    this.name = 'CorruptRoomError';
    this.roomId = roomId;
  }
}

// — the value-semantics gate ——————————————————————————————————————————————
//
// Every room enters and leaves both stores through these three functions, so
// neither store can hold, return, or hand back a value the other would not.
// A room that would not survive `JSON.stringify` → `JSON.parse` unchanged in
// shape is rejected at the door rather than written: storing one bricks the
// Redis room for its whole 7-day TTL, while the memory path keeps serving it.
//
// This is a **JSON-stability check on the declared shape**, not a second copy of
// the rules. It asks "are these bytes a `Room`, field by field, as §7.1 and §7.4
// declare it" — finite numbers where the type says `number`, the literals where
// the type says a union, null-or-shape where the type says so. It does not ask
// whether the position is legal, reachable, or consistent: a board of 24 White
// pieces with an empty hand passes here and is the engine's business, not the
// store's. `apply()` remains the only judge of legality.

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isSeatMap = (v: unknown, ok: (seat: unknown) => boolean): boolean =>
  isObject(v) && ok(v.W) && ok(v.B);

/**
 * A counter: `0, 1, 2, …`, never `1.5`, never negative, and never so large that
 * arithmetic on it stops working.
 *
 * `Number.isSafeInteger`, not `isInteger`: `9007199254740992 + 1` is
 * `9007199254740992`, so a room `set` at or above 2^53 makes `update` write back
 * the version it read, the compare-and-set never sees a change, and *every*
 * subsequent `update` pinned to that version wins. Two writers committing from
 * one version is the single thing this store exists to prevent, and only this
 * gate stands between `set` — which is public API — and that hole.
 */
const isCount = (v: unknown): boolean =>
  Number.isSafeInteger(v) && (v as number) >= 0;

/** A board index, `0 … POINT_COUNT - 1`. `POINT_COUNT` is imported, not copied. */
const isPoint = (v: unknown): boolean => isCount(v) && (v as number) < POINT_COUNT;

/**
 * Membership in one of the engine's own literal lists. The engine derives its
 * types *from* these arrays (`type Player = (typeof PLAYERS)[number]`), so
 * importing the array is importing the definition — there is nothing here that
 * can drift out of step with it, which is why this is a check and not a mirror.
 */
const isOneOf = (list: readonly string[], v: unknown): boolean =>
  list.some((member) => member === v);

/**
 * A scalar for an error message, without ever throwing from inside the error
 * path. `JSON.stringify` throws on a `BigInt` and returns `undefined` for a
 * function, a symbol or `undefined` itself, so the gate could not report the one
 * thing it had been asked to report.
 *
 * Exported because `RedisStore` has to describe one more caller-controlled value
 * the gate never sees — whatever the update script returned — and a second
 * `JSON.stringify` in an error path is the same defect in a new place.
 */
export function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return `a ${typeof value} with no JSON form`;
  }
}

/**
 * The reason `game` is not a `GameState` as GDD §7.1 declares it, or `null`.
 *
 * Every field is checked, and checked against the engine's own definitions
 * rather than a copy of them: `POINT_COUNT` for the board's size, `PLAYERS`,
 * `PHASES` and `REASONS` for its four string unions. The engine derives those
 * types from those arrays, so there is one source of truth and this file reads
 * it. Numbers that are counts by meaning are checked as counts (`hand`,
 * `movesSinceRemoval`), and `lastMove` holds board indices, not arbitrary
 * integers.
 *
 * So nothing about a `GameState` arriving from Redis goes unvalidated except
 * whether the *position* is legal — whether that board could be reached, whether
 * that hand matches those pieces, whether it is really that player's turn. That
 * is `apply()`'s job and deliberately not the store's: a board of 24 White
 * pieces is a well-formed `GameState` and an impossible game, and only one of
 * those two is a storage question.
 */
function whyNotAGameState(game: unknown): string | null {
  if (!isObject(game)) return 'game is not a game state';

  const board: unknown = game.board;
  if (!Array.isArray(board) || board.length !== POINT_COUNT) {
    return `game.board is not ${POINT_COUNT} points`;
  }
  // `Array.from` first: a sparse `new Array(24)` has `length === 24` and
  // `Array.prototype.every` skips its holes, so `board.every(...)` would pass it
  // — and `JSON.stringify` would then quietly turn every hole into `null`,
  // emptying the board. `Array.from` materialises the holes as `undefined`,
  // which fails the cell test like any other non-cell.
  if (!Array.from(board).every((c) => c === null || isOneOf(PLAYERS, c))) {
    return 'game.board holds something that is not a piece';
  }
  if (!isSeatMap(game.hand, isCount)) {
    return 'game.hand is not a pair of whole counts';
  }
  if (!isOneOf(PLAYERS, game.turn)) return 'game.turn is not a player';
  if (!isOneOf(PHASES, game.phase)) return 'game.phase is not a phase';
  if (typeof game.pendingRemoval !== 'boolean') {
    return 'game.pendingRemoval is not a flag';
  }
  if (!isCount(game.movesSinceRemoval)) {
    return 'game.movesSinceRemoval is not a whole count';
  }

  const lastMove: unknown = game.lastMove;
  if (lastMove !== null) {
    if (!isObject(lastMove)) return 'game.lastMove is neither a move nor null';
    if (!(lastMove.from === null || isPoint(lastMove.from))) {
      return 'game.lastMove.from is neither a point nor null';
    }
    if (!isPoint(lastMove.to)) return 'game.lastMove.to is not a point';
  }

  const result: unknown = game.result;
  if (result !== null) {
    if (!isObject(result)) return 'game.result is neither a result nor null';
    if (!(result.winner === null || isOneOf(PLAYERS, result.winner))) {
      return 'game.result.winner is neither a player nor null';
    }
    if (!isOneOf(REASONS, result.reason)) {
      return 'game.result.reason is not a reason';
    }
  }
  return null;
}

/**
 * The reason `value` is not a {@link Room}, or `null` if it is one. Covers the
 * §7.4 envelope and, through {@link whyNotAGameState}, every field of the
 * `GameState` it carries — because `GET /api/game/[id]` copies `game` into a 200
 * body without `apply()` ever seeing it, so anything unchecked here is served to
 * clients as success.
 */
function whyNotARoom(value: unknown): string | null {
  if (!isObject(value)) return `value is ${describeValue(value)}`;

  // Store-owned counters, checked exactly, because the two implementations have
  // to agree on them. `version: 1.5` used to pass: the memory path then compares
  // and reports 1.5, while Redis returns it through Lua's integer conversion,
  // which truncates — so the same room produced `actualVersion: 1.5` on one path
  // and `1` on the other, against the promise that the two agree.
  for (const field of ['version', 'gameNumber']) {
    if (!isCount(value[field])) {
      return `${field} is not a whole count`;
    }
  }
  for (const field of ['createdAt', 'turnStartedAt']) {
    if (!Number.isFinite(value[field])) return `${field} is not a number`;
  }
  if (!(value.timerMs === null || Number.isFinite(value.timerMs))) {
    return 'timerMs is neither a number nor null';
  }
  if (!isSeatMap(value.players, (s) => s === null || typeof s === 'string')) {
    return 'players is not a pair of tokens';
  }
  for (const field of ['rematch', 'drawOffer']) {
    if (!isSeatMap(value[field], (s) => typeof s === 'boolean')) {
      return `${field} is not a pair of flags`;
    }
  }
  return whyNotAGameState(value.game);
}

/**
 * `value` as a {@link Room} filed under `id`, or {@link CorruptRoomError}.
 *
 * The `id` comparison is not redundant with the write path's. The write path
 * guarantees what *this* store writes; this runs on the way out, and
 * the whole reason the outbound gate exists is the case where something else
 * wrote the key, or where a stored room predates a change to {@link Room}. A
 * room read back from `room:ABCD2345` announcing `id: 'HIJACKED'` used to be
 * handed to the API verbatim and copied into a 200 body.
 */
function assertRoom(value: unknown, id: string): Room {
  const bad = whyNotARoom(value);
  if (bad !== null) throw new CorruptRoomError(id, bad);
  const room = value as Room;
  if (room.id !== id) {
    // `describeValue`, not `JSON.stringify`: this is an error path over a
    // caller-controlled value, which is the whole reason that helper exists. A
    // bigint id made `JSON.stringify` throw, so a room refused for disagreeing
    // with its key was reported as `the room could not be read (Do not know how
    // to serialize a BigInt)` — a serialisation complaint for an id
    // disagreement — and a symbol id rendered as `room announces id undefined`,
    // the exact emptiness the `?? String(value)` fallback exists to prevent.
    throw new CorruptRoomError(id, `room announces id ${describeValue(room.id)}`);
  }
  return room;
}

/**
 * The JSON a store holds for `room`, checked on both sides of the serialisation.
 * Purely a verifier: it corrects nothing.
 *
 * **One policy for the store-owned fields — refuse, never correct — but two
 * different checks, because the two fields are not symmetric.**
 *
 * - `id` is checked against the **key**, on both the pre-image and the
 *   post-image: two sides, one question. It used to be silently rewritten on the
 *   way in (`{ ...room, id }`) while a `toJSON` that changed it on the way out
 *   was refused — the same field, opposite policies, a few lines apart. The
 *   argument for refusing on the far side (silently rewriting hides the caller's
 *   mistake rather than reporting it) argued against the near side too.
 * - `version` has no store expectation to disagree with on the pre-image: `set`
 *   accepts whatever version it is handed, and `update` supplies its own. Its
 *   only cross-check is post-image against the value that went in — one side,
 *   asking whether serialising changed it.
 *
 * That does not make `update` stricter, because `update` does not *correct* those
 * fields, it *supplies* them: it hands this function `{ ...fn(room), id, version }`
 * and the check then agrees, exactly as `RoomStore.update` says it will. The
 * distinction is between a caller that derives a room (where the store owns two
 * fields and writes them) and a caller that hands over a whole one (where the
 * store owns two fields and verifies them).
 *
 * Checked *before*, because that is where some information only exists: `NaN` in
 * a nullable field round-trips to `null` — a legal value the caller never meant,
 * and a turn timer silently switched off — and only the pre-image tells the two
 * apart.
 *
 * Checked *after*, because an own `toJSON` anywhere in the room decides what
 * `JSON.stringify` actually emits, so the object that was checked and the bytes
 * that get written are not the same thing. `version` is compared across that gap
 * as well: `update` sets it on the object, and a room serialising to
 * `{ ...room, version: 1 }` let three successive `update(id, fn, 1)` calls all
 * succeed, each clobbering the last.
 *
 * The bytes are then re-emitted from the parsed tree, never from the caller's
 * object. Serialising the caller's object a second time would call its `toJSON`
 * a second time, and a `toJSON` that answers differently on each call would have
 * one value validated and a different one written.
 */
export function roomToJson(room: Room, id: string): string {
  // Read `version` here, inside the guard, rather than again at the bottom: a
  // getter is entitled to throw on its second read as easily as its first.
  // Pinned by a getter that answers once and then throws — every other hostile
  // getter in the suite throws on *every* read, so the first read inside
  // `assertRoom` throws and no second read is ever reached.
  const given = guardingReads(id, 'the room', () => {
    assertRoom(room, id);
    return room.version;
  });

  const json = stringifyOrThrow(room, id, 'the room');

  const emitted = assertRoom(JSON.parse(json), id);
  if (emitted.version !== given) {
    // `describeValue(given)`, for the same reason as `assertRoom`'s id: `given`
    // is the *second* read of a caller's `version`, so a getter that answers a
    // valid count for `assertRoom` and a symbol afterwards puts a symbol in this
    // template — and interpolating one throws `TypeError: Cannot convert a
    // Symbol value to a string`, from outside `guardingReads`, straight past
    // the three types `RoomStore.update` promises. `emitted.version` needs no
    // such care: it came out of `JSON.parse` and `assertRoom` has already
    // checked it is a whole count.
    throw new CorruptRoomError(
      id,
      `serialising the room changed version from ${describeValue(given)} to ${emitted.version}`,
    );
  }
  // `json` itself, not `JSON.stringify(emitted)`: re-serialising the parse of a
  // string `JSON.stringify` produced is the identity on it, so that was dead
  // work. What the justification was ever about is that these bytes come from
  // `stringifyOrThrow` and are the ones just validated — never from a second
  // pass over the caller's object, which would call its `toJSON` again.
  return json;
}

/**
 * Reads `read`, answering `undefined` if it throws.
 *
 * Every read of a caller-controlled value below goes through here, and that
 * includes the type tests: `message` may be a getter that throws, an object's
 * `toString` may throw, and `instanceof` invokes `[[GetPrototypeOf]]`, which a
 * `Proxy` can trap and throw from — so even asking what something *is* is a read
 * that can fail.
 *
 * At module scope rather than inside {@link reason}, because {@link guardingReads}
 * needs it too. It used to write `cause instanceof CorruptRoomError` directly,
 * two functions below the comment naming this exact hazard, so a cause that was
 * a `Proxy` trapping `getPrototypeOf` made the guard written to stop raw
 * exceptions escaping throw one itself — a bare `Error` out of `set` and
 * `update` on both implementations, none of the three types
 * {@link RoomStore.update} promises and none of them naming the room.
 */
const tried = <T>(read: () => T): T | undefined => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

/**
 * Why something failed, from a value that need not be an `Error` and whose own
 * `message` may throw. `throw null`, `throw undefined` and `throw 'a string'`
 * are all legal, and `(cause as Error).message` on the first two throws a
 * `TypeError` out of the error path itself — which is the failure this whole
 * layer exists to prevent, reintroduced inside its own handler. A plain string
 * cause used to render as `undefined`, saying nothing about what arrived.
 */
function reason(cause: unknown): string {
  if (tried(() => cause instanceof Error) === true) {
    const message = tried(() => (cause as Error).message);
    if (typeof message === 'string') return message;
    // Not `describeValue(cause)` here: an `Error` serialises to `{}`, which names
    // nothing — the same emptiness as the `undefined` a plain string cause used
    // to render as. The class name is the one thing left that identifies it.
    const name = tried(() => (cause as Error).name);
    return `an unreadable ${typeof name === 'string' ? name : 'Error'}`;
  }
  return describeValue(cause);
}

/**
 * `JSON.stringify`, with every way it can fail reported as
 * {@link CorruptRoomError}: it *throws* on a cycle or a `BigInt`, and *returns*
 * the value `undefined` for a `toJSON` yielding undefined, a function or a
 * symbol — which would then parse back to a `SyntaxError`. In an operator's log
 * a raw `TypeError` or `SyntaxError` from in here is indistinguishable from a
 * bug in the store itself.
 */
function stringifyOrThrow(value: unknown, id: string, what: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new CorruptRoomError(
      id,
      `${what} cannot be serialised (${reason(cause)})`,
    );
  }
  if (json === undefined) throw new CorruptRoomError(id, `${what} has no JSON form`);
  return json;
}

/**
 * Runs `read`, turning anything it throws into {@link CorruptRoomError}.
 *
 * Validating a room means *reading* its fields, and a caller's object can make
 * that throw: a getter on `version` or `game`, or a `Proxy` that throws on any
 * read. Those escaped verbatim while a throwing getter on an *undeclared* field
 * was reported properly, because only `JSON.stringify` ever reached that one.
 *
 * Exported because `update` spreads `fn`'s result to apply the store-owned
 * fields, and a spread is a read like any other. It deliberately wraps only the
 * spread, never the call to `fn`: a caller's own exception is the caller's, and
 * must reach them unchanged.
 */
export function guardingReads<T>(id: string, what: string, read: () => T): T {
  try {
    return read();
  } catch (cause) {
    // `tried`, not a bare `instanceof`: `cause` is whatever the caller's getter
    // or `Proxy` trap threw, and a `Proxy` can trap `getPrototypeOf` and throw
    // from the type test itself. See `tried` for what that used to cost.
    if (tried(() => cause instanceof CorruptRoomError) === true) throw cause;
    throw new CorruptRoomError(
      id,
      `${what} could not be read (${reason(cause)})`,
    );
  }
}

/**
 * A value a store read back, as a {@link Room}.
 *
 * Accepts the JSON string this store writes and the pre-parsed object a client
 * built with Upstash's automatic deserialization hands back — and puts **both**
 * through the same round trip. The object branch used to validate the client's
 * object and return it: `get` handed out the very object the client held, so
 * mutating the result changed what the next `get` returned, an `fn` that mutated
 * and then threw still left its damage on it, and a stored `Date` came back a
 * `Date` — a value `MemoryStore` could never return. Production never saw it,
 * because `createStore` always passes `automaticDeserialization: false`, but the
 * `RedisClient` seam is public and the branch is deliberate, so it holds the
 * same guarantee as every other path or it should not exist.
 */
export function roomFromStored(raw: unknown, id: string): Room {
  const json =
    typeof raw === 'string'
      ? raw
      : stringifyOrThrow(raw, id, 'the stored value');
  return roomFromJson(json, id);
}

/** The room `json` holds, or {@link CorruptRoomError}. */
export function roomFromJson(json: string, id: string): Room {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new CorruptRoomError(id, `value is not JSON (${reason(cause)})`);
  }
  return assertRoom(value, id);
}
