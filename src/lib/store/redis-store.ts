/**
 * Upstash Redis `RoomStore` (GDD §7.2). Keys are `room:{id}`, values are the
 * JSON room, TTL is 7 days and is refreshed on every write.
 *
 * The client is injected rather than constructed here: it keeps this file free of
 * env handling (that lives in `get-store.ts`) and lets the tests run the real
 * logic against a fake that implements only the three commands used below.
 */

import {
  CorruptRoomError,
  RoomNotFoundError,
  VersionConflictError,
  describeValue,
  guardingReads,
  roomFromJson,
  roomFromStored,
  roomToJson,
} from './types';
import type { Room, RoomStore } from './types';

/** GDD §7.2: rooms live 7 days, refreshed on write. */
export const ROOM_TTL_SECONDS = 7 * 24 * 60 * 60;

export function roomKey(id: string): string {
  return `room:${id}`;
}

/**
 * The only Redis commands this store uses. Structurally satisfied by
 * `@upstash/redis`'s `Redis`, and small enough to fake exactly in tests.
 */
export interface RedisClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts: { ex: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/**
 * Compare-and-set on the room's version, run inside Redis so that the compare and
 * the write cannot be split by a concurrent writer. Upstash's REST API has no
 * `WATCH`/`MULTI`, so a script is the only way to get atomicity — a read-then-write
 * from the client would lose updates.
 *
 * `KEYS[1]` room key, `ARGV[1]` next room JSON, `ARGV[2]` expected version,
 * `ARGV[3]` TTL in seconds. Returns `[status, version]`:
 * `[1, newVersion]` written, `[0, currentVersion]` version mismatch,
 * `[-1, -1]` key missing, `[-2, -2]` the stored value is not a room.
 *
 * The `-2` status is the CAS window's own corruption case: something else wrote
 * the key between this store's read and this script's compare. Without it the
 * script had two ways to answer that, both wrong. `cjson.decode` *raises* on
 * bytes that are not JSON, which reaches the caller as an `UpstashError`; and a
 * value that decodes but has no numeric `version` reached
 * `return {0, room.version}` with `room.version` nil — a Lua table's array part
 * ends at its first nil, so that returned the one-element `{0}` and the caller
 * got `Error: Unexpected result from the room update script: [0]`. Neither
 * carries `roomId`, and neither is one of the three types
 * {@link RoomStore.update} promises. `pcall` and an explicit type check turn
 * both into one status that `update` maps to {@link CorruptRoomError}.
 *
 * `type(room) ~= 'table'` is not redundant with the `version` check: `cjson`
 * decodes a bare `42` or `"x"` to a Lua number or string, and indexing one
 * raises — putting the failure back on the path this status exists to close.
 */
export const UPDATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return {-1, -1} end
local ok, room = pcall(cjson.decode, current)
if not ok or type(room) ~= 'table' or type(room.version) ~= 'number' then return {-2, -2} end
local expected = tonumber(ARGV[2])
if room.version ~= expected then return {0, room.version} end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return {1, expected + 1}
`.trim();

// Every status the script can return has a name, including the one that used to
// have none. `-1` was handled by a trailing `throw new RoomNotFoundError(id)`
// that doubled as the fall-through for *every* unrecognised status, so a status
// the script does not currently produce — `[7, 7]`, `[-3, -3]`, `[2, 9]` — was
// reported as a 404 while the room was still sitting under the key, and the
// client discarded a live game. Named separately so the fall-through can be
// loud.
const WRITTEN = 1;
const VERSION_MISMATCH = 0;
const KEY_MISSING = -1;
const NOT_A_ROOM = -2;

export class RedisStore implements RoomStore {
  constructor(private readonly client: RedisClient) {}

  async get(id: string): Promise<Room | null> {
    return parseRoom(await this.client.get(roomKey(id)), id);
  }

  async set(id: string, room: Room): Promise<void> {
    await this.client.set(roomKey(id), roomToJson(room, id), {
      ex: ROOM_TTL_SECONDS,
    });
  }

  async update(
    id: string,
    fn: (room: Room) => Room,
    expectedVersion: number,
  ): Promise<Room> {
    // The read is not an optimisation — `fn` needs the current room, so it
    // cannot be removed. The version check in front of it is a fast path, and
    // its justification used to be wrong: it claimed `fn` is the API layer's
    // `apply()` and would throw `IllegalActionError` on a stale position. It is
    // not. Both real callers pass a room computed *before* the call
    // (`handlers.ts` builds `next` and passes `() => next`; the join route
    // passes a spread), neither can throw, and `handlers.ts` version-checks
    // before it calls the mutation at all. What the check actually buys:
    //
    //  - a stale caller is refused without an `EVAL` round trip;
    //  - `fn` is not run against a room the store already knows is stale, which
    //    is what makes "`fn` runs at most once, and never on a known-stale
    //    room" a property of `update` rather than an accident of the callers.
    //
    // The script is what makes the write safe; this only decides how cheaply
    // and how early a doomed call is turned away.
    const current = await this.get(id);
    if (!current) throw new RoomNotFoundError(id);
    if (current.version !== expectedVersion) {
      throw new VersionConflictError(id, expectedVersion, current.version);
    }

    // Exactly the bytes that go to Redis, checked to still be a room after the
    // round trip. Returning `fn`'s object instead would hand the caller `NaN`
    // where the stored room has `null`, and would alias `fn`'s nested objects —
    // the memory store, which has to serialise, would do neither.
    // `update` supplies both store-owned fields; `roomToJson` verifies them.
    // `fn` is called outside the guard: its own exception is the caller's and
    // must reach them unchanged. The *spread* is inside, because reading the
    // object it returns can throw on a getter or a proxy.
    const built = fn(current);
    const nextJson = roomToJson(
      guardingReads(id, 'the next room', () => ({
        ...built,
        id,
        version: expectedVersion + 1,
      })),
      id,
    );

    // The room may have moved since the read above; the script re-checks the
    // version at write time and refuses to clobber a newer write.
    const [status, version] = parseScriptResult(
      await this.client.eval(
        UPDATE_SCRIPT,
        [roomKey(id)],
        [nextJson, String(expectedVersion), String(ROOM_TTL_SECONDS)],
      ),
      id,
    );

    // Unpinnable, like `MemoryStore`'s: `roomToJson` validated this exact string
    // above, so no test can tell it from `JSON.parse(nextJson) as Room`. Kept
    // for the same two reasons — a fresh tree without a cast, and a standing
    // rule against deleting guards on unreachability grounds.
    if (status === WRITTEN) return roomFromJson(nextJson, id);
    if (status === VERSION_MISMATCH) {
      throw new VersionConflictError(id, expectedVersion, version);
    }
    if (status === NOT_A_ROOM) {
      // The same type `MemoryStore` reports from the same window, which is what
      // the contract on `RoomStore.update` promises — but deliberately not the
      // same *detail*, and not because the detail is unavailable in principle.
      // `MemoryStore` re-reads the bytes and puts them back through
      // `roomFromJson`, so its code can name the reason (`value is not JSON (…)`,
      // `value is 42`, `version is not a whole count`) — even though nothing can
      // reach that path in a private `Map`. Here the compare happens
      // inside Redis and the script returns a status, not the value, so there is
      // nothing to describe without a second round trip that would race the very
      // window this closes. Agreeing on the type is the promise; the reason is
      // best-effort on each path.
      throw new CorruptRoomError(
        id,
        'the stored value stopped being a room between the read and the write',
      );
    }
    if (status === KEY_MISSING) throw new RoomNotFoundError(id);
    // Not reachable from `UPDATE_SCRIPT` as written — but the `RedisClient` seam
    // is public, and "not producible today" has been the wrong reason to drop a
    // guard three times in this directory. An unrecognised status means the value
    // under this key, or the script over it, is not what this store wrote, which
    // is what `CorruptRoomError` says; it is also one of the three types
    // `RoomStore.update` promises, and it names the room. Reporting it as
    // "not found" claimed something specific and false about a room that is
    // still there.
    throw new CorruptRoomError(
      id,
      `the room update script returned status ${status}`,
    );
  }
}

/**
 * Turns whatever came back from Redis into a `Room`, or throws.
 *
 * The value is normally the JSON string this store wrote; a client built with
 * Upstash's automatic deserialization on hands back a parsed object instead, and
 * both are accepted, and both go through the same round trip in
 * {@link roomFromStored}, so neither can alias the client's own object. Neither
 * is *trusted*: `unknown` is not a `Room` until something has looked, and a blind
 * cast would hand the API layer a `42` typed as a room, or a room with no
 * `version` — which lands in a 409 body as `actualVersion: undefined` against a
 * field declared `number`. The shape rules live in `types.ts`, shared with every
 * write on both implementations.
 */
function parseRoom(raw: unknown, id: string): Room | null {
  if (raw === null || raw === undefined) return null;
  return roomFromStored(raw, id);
}

/**
 * The script's `[status, version]`, or {@link CorruptRoomError}.
 *
 * `CorruptRoomError` rather than a plain `Error`, and `id` is threaded in for
 * it: a result that is not a pair of numbers means the value under the key is
 * not what this store wrote — the script changed, or something else did — and
 * {@link RoomStore.update} promises exactly three types, all of which name the
 * room. The `[0]` case that used to land here was precisely that, reported as an
 * anonymous `Error`; the script now answers it as `-2` instead, and this is the
 * backstop for whatever is left.
 *
 * `describeValue`, not `JSON.stringify`: this is an error path, and the value
 * comes from the injectable `RedisClient` seam, so it can be a `BigInt` that
 * `JSON.stringify` throws on or a function it returns `undefined` for.
 */
function parseScriptResult(
  raw: unknown,
  id: string,
): [status: number, version: number] {
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    typeof raw[0] === 'number' &&
    typeof raw[1] === 'number'
  ) {
    return [raw[0], raw[1]];
  }
  throw new CorruptRoomError(
    id,
    `the room update script returned ${describeValue(raw)}`,
  );
}
