/**
 * Process-local `RoomStore` (GDD §7.2). Used by tests, `npm run dev`, and the
 * e2e suite — anywhere `KV_REST_API_URL` is absent.
 *
 * The point of this class is that a bug cannot hide here and then appear against
 * Redis, so it holds what Redis holds — the room's JSON — and passes every room
 * in and out through the same `roomToJson` / `roomFromJson` gate the Redis store
 * uses. Nothing here is a shortcut taken because the map is local:
 *
 * - Rooms round-trip through JSON, not `structuredClone`. `structuredClone`
 *   preserves `NaN`, `undefined`-valued keys, `Date`s and `Map`s, all of which
 *   `JSON.stringify` destroys. Redis stores JSON, so JSON is what counts.
 * - `update` has a real window between its read and its write, because the Redis
 *   one does — its read is a network round trip. Closing that window here would
 *   make the memory path stricter than production and hide lost-update bugs in
 *   dev and e2e. The window is safe because the version is compared again at
 *   write time; that re-check, not the absence of a window, is what makes
 *   `update` a compare-and-set.
 */

import {
  RoomNotFoundError,
  VersionConflictError,
  guardingReads,
  roomFromJson,
  roomToJson,
} from './types';
import type { Room, RoomStore } from './types';

export class MemoryStore implements RoomStore {
  private readonly rooms = new Map<string, string>();

  async get(id: string): Promise<Room | null> {
    // `roomFromJson` rather than a blind `JSON.parse` even though this map only
    // ever holds JSON this class validated on the way in. No test can tell the
    // two apart, and that is the point: "unreachable by construction" is the
    // argument that justified deleting the post-serialisation check last pass,
    // and it was wrong — so the standard here is to validate at every boundary
    // and record the ones that cannot be pinned, not to reason them away.
    const json = this.rooms.get(id);
    return json === undefined ? null : roomFromJson(json, id);
  }

  async set(id: string, room: Room): Promise<void> {
    this.rooms.set(id, roomToJson(room, id));
  }

  async update(
    id: string,
    fn: (room: Room) => Room,
    expectedVersion: number,
  ): Promise<Room> {
    const atRead = this.rooms.get(id);
    if (atRead === undefined) throw new RoomNotFoundError(id);

    const current = roomFromJson(atRead, id);
    if (current.version !== expectedVersion) {
      throw new VersionConflictError(id, expectedVersion, current.version);
    }

    // `fn` gets its own copy, so mutating it — or mutating it and then throwing
    // — cannot reach the stored room. Nothing is written until `fn` returns a
    // room that survives the round trip.
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

    // The write window that the Redis round trip has. Everything below is the
    // compare-and-set: re-read, re-compare, write, with no await between them.
    await Promise.resolve();

    const atWrite = this.rooms.get(id);
    // Unreachable today — this map never deletes — but it is the case the Redis
    // script reports as `[-1, -1]`, where a key really can vanish to its TTL
    // between the read and the write. Kept so the two paths cannot drift.
    if (atWrite === undefined) throw new RoomNotFoundError(id);
    const stored = roomFromJson(atWrite, id);
    if (stored.version !== expectedVersion) {
      throw new VersionConflictError(id, expectedVersion, stored.version);
    }

    this.rooms.set(id, nextJson);
    // Unpinnable, like `get`'s: `roomToJson` validated this exact string four
    // statements up, so no test can tell this from `JSON.parse(nextJson) as
    // Room`. Kept because it is also what makes the return a fresh tree with no
    // cast, and because "unreachable by construction" has twice been the wrong
    // reason to delete a guard in this directory.
    return roomFromJson(nextJson, id);
  }
}
