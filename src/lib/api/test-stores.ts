/**
 * Stores that misbehave on purpose, for the paths a real `MemoryStore` cannot
 * reach: a write that loses its race, a room that expires mid-write, and a
 * store that throws something this layer does not recognise.
 *
 * Used by `handlers.test.ts` for the shared write path and by `join.test.ts`
 * for /join's own retry loop — the two places GDD §7.2's optimistic-concurrency
 * contract is exercised.
 */

import { VersionConflictError } from '@/lib/store';
import type { MemoryStore, Room, RoomStore } from '@/lib/store';

/**
 * A store that drops an unrelated write — the seated player moving, say —
 * between a caller's read and its update, `races` times. Every read the caller
 * takes is therefore already stale by the time it writes.
 */
export class RacingStore implements RoomStore {
  constructor(
    private readonly inner: MemoryStore,
    private races: number,
  ) {}

  async get(id: string): Promise<Room | null> {
    const room = await this.inner.get(id);
    if (room !== null && this.races > 0) {
      this.races -= 1;
      // A write that bumps the version and nothing a caller would notice, so
      // the race is the only thing under test.
      await this.inner.update(
        id,
        (current) => ({ ...current, turnStartedAt: current.turnStartedAt + 1 }),
        room.version,
      );
    }
    return room;
  }

  set(id: string, room: Room): Promise<void> {
    return this.inner.set(id, room);
  }

  update(
    id: string,
    fn: (room: Room) => Room,
    expectedVersion: number,
  ): Promise<Room> {
    return this.inner.update(id, fn, expectedVersion);
  }
}

/**
 * A store where every write loses its race, and where the room has changed — or
 * gone, as an expired Redis key does — from the read after the `after`th. It is
 * how the paths a caller reaches only *after* giving up on retries are tested.
 */
export class RaceLostStore implements RoomStore {
  private reads = 0;
  /** How many times the caller tried to write before giving up. */
  attempts = 0;

  constructor(
    private readonly inner: MemoryStore,
    private readonly after: number,
    private readonly change: (room: Room) => Room | null,
  ) {}

  async get(id: string): Promise<Room | null> {
    this.reads += 1;
    const room = await this.inner.get(id);
    if (room === null || this.reads <= this.after) return room;
    return this.change(room);
  }

  set(id: string, room: Room): Promise<void> {
    return this.inner.set(id, room);
  }

  async update(
    id: string,
    _fn: (room: Room) => Room,
    expectedVersion: number,
  ): Promise<Room> {
    this.attempts += 1;
    throw new VersionConflictError(id, expectedVersion, expectedVersion + 1);
  }
}

/** The room is gone by then. */
export const vanishes = (): null => null;

/** Someone else has taken the free seat by then. */
export const seatTaken = (room: Room): Room => ({
  ...room,
  players: { ...room.players, B: 'someone-else' },
});

/** A store whose chosen method throws whatever it was handed. */
export class BrokenStore implements RoomStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly failing: 'get' | 'set' | 'update',
    /** `unknown`, because a store could throw something that is not an `Error`. */
    private readonly error: unknown,
  ) {}

  async get(id: string): Promise<Room | null> {
    if (this.failing === 'get') throw this.error;
    return this.inner.get(id);
  }

  async set(id: string, room: Room): Promise<void> {
    if (this.failing === 'set') throw this.error;
    return this.inner.set(id, room);
  }

  async update(
    id: string,
    fn: (room: Room) => Room,
    expectedVersion: number,
  ): Promise<Room> {
    if (this.failing === 'update') throw this.error;
    return this.inner.update(id, fn, expectedVersion);
  }
}
