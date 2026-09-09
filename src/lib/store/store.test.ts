import { describe, expect, it, vi } from 'vitest';

import { PHASES, PLAYERS, POINT_COUNT, REASONS, initialState } from '@/lib/engine';
import type { Cell, GameState, Player, Reason } from '@/lib/engine';

import { MemoryStore } from './memory-store';
import {
  ROOM_TTL_SECONDS,
  RedisStore,
  UPDATE_SCRIPT,
  roomKey,
} from './redis-store';
import type { RedisClient } from './redis-store';
import {
  CorruptRoomError,
  RoomNotFoundError,
  VersionConflictError,
} from './types';
import type { Room, RoomStore } from './types';

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 'ABCD2345',
    version: 1,
    createdAt: 1_700_000_000_000,
    players: { W: 'token-w', B: null },
    timerMs: 300_000,
    turnStartedAt: 1_700_000_000_000,
    game: initialState(),
    rematch: { W: false, B: false },
    drawOffer: { W: false, B: false },
    gameNumber: 1,
    ...overrides,
  };
}

/**
 * A seat map that is an **array** carrying `W` and `B`. TypeScript sees
 * `unknown[] & { W: T; B: T }`, which is structurally a `{ W: T; B: T }`, so
 * this reaches `Room` with no cast anywhere — and `isSeatMap`'s `isObject`
 * conjunct is the only thing that refuses it.
 *
 * The `toJSON` is load-bearing: it serialises the array to the honest pair, so
 * the post-image check sees a well-formed room and only the pre-image can tell
 * the array from the object. Without it the array emits as `[]`, the post-image
 * refuses it with the very same sentence, and the row passes whether the
 * conjunct is there or not.
 */
function arraySeats<T>(W: T, B: T): { W: T; B: T } {
  return Object.assign([] as unknown[], { W, B, toJSON: () => ({ W, B }) });
}

/**
 * A `game.result` that is an **array** carrying `winner` and `reason`. The same
 * trick as {@link arraySeats}, aimed at the `isObject` call site in
 * `whyNotAGameState`'s `result` arm: `unknown[] & { winner; reason }` is structurally a
 * `Result`, so it reaches `GameState` with no cast, and its `.winner` and
 * `.reason` are exactly what the two field checks below the guard want.
 *
 * The `toJSON` is load-bearing for a different reason than `arraySeats`'s, and
 * the difference matters. Without it the array emits as `[]`, the *post-image*
 * refuses it, and the sentence that comes back names `game.result.winner` — a
 * neighbouring guard answering a different question about a room whose
 * pre-image was never refused at all. With it, the post-image is a well-formed
 * room and only `isObject(result)` can tell the array from the object, so the
 * row pins the guard it is named for rather than one next to it.
 */
function arrayResult(
  winner: Player | null,
  reason: Reason,
): { winner: Player | null; reason: Reason } {
  return Object.assign([] as unknown[], {
    winner,
    reason,
    toJSON: () => ({ winner, reason }),
  });
}

/**
 * A stand-in for Upstash implementing only the three commands `RedisStore` uses.
 * `eval` accepts nothing but `UPDATE_SCRIPT` and reproduces its semantics — read,
 * compare the stored version, write with a fresh TTL — so the store's real code
 * path runs without a Redis. `onBeforeEval` lets a test drop a competing write in
 * between the store's read and the script's compare, deterministically.
 */
class FakeRedis implements RedisClient {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  /** Every EVAL as it would go on the wire, in order. */
  readonly frames: (string | number)[][] = [];
  onBeforeEval: (() => void) | null = null;

  async get(key: string): Promise<unknown> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    opts: { ex: number },
  ): Promise<unknown> {
    this.values.set(key, value);
    this.ttls.set(key, opts.ex);
    return 'OK';
  }

  /**
   * Encodes the call into the frame `@upstash/redis` actually sends, then runs
   * the script *from that frame* — never from the arguments directly. Asserting
   * the store's own call arguments cannot tell `eval(script, keys, args)` from
   * `eval(script, args, keys)`, because the fake would read them back in the
   * same order it was handed them. Going through the wire encoding does: a
   * transposition puts three keys and one argument on the wire, and everything
   * below then looks for the room under the wrong key.
   */
  async eval(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<unknown> {
    const frame: (string | number)[] = [
      'eval',
      script,
      keys.length,
      ...keys,
      ...args,
    ];
    this.frames.push(frame);
    this.onBeforeEval?.();
    return this.runFrame(frame);
  }

  private runFrame(frame: (string | number)[]): unknown {
    const [command, script, numKeys, ...rest] = frame;
    if (command !== 'eval') throw new Error(`FakeRedis got ${String(command)}`);
    if (script !== UPDATE_SCRIPT) {
      throw new Error('FakeRedis was asked to run an unknown script');
    }
    const keys = rest.slice(0, Number(numKeys)).map(String);
    const [nextJson, expectedVersion, ttl] = rest
      .slice(Number(numKeys))
      .map(String);

    const current = this.values.get(keys[0]);
    if (current === undefined) return [-1, -1];

    // The script's `-2`, transcribed. `pcall(cjson.decode, …)` fails on bytes
    // that are not JSON; `type(room) ~= 'table'` rejects a bare number, string,
    // boolean or `null`, none of which decode to a Lua table; and a table with
    // no numeric `version` — including a JSON array — is not a room either.
    let stored: unknown;
    try {
      stored = JSON.parse(current);
    } catch {
      return [-2, -2];
    }
    if (typeof stored !== 'object' || stored === null) return [-2, -2];
    const version: unknown = (stored as { version?: unknown }).version;
    if (typeof version !== 'number') return [-2, -2];

    if (version !== Number(expectedVersion)) return [0, version];

    this.values.set(keys[0], nextJson);
    this.ttls.set(keys[0], Number(ttl));
    return [1, Number(expectedVersion) + 1];
  }
}

const implementations: [name: string, create: () => RoomStore][] = [
  ['MemoryStore', () => new MemoryStore()],
  ['RedisStore', () => new RedisStore(new FakeRedis())],
];

describe.each(implementations)('%s', (_name, create) => {
  it('round-trips a room through set and get', async () => {
    const store = create();
    const room = makeRoom();

    await store.set(room.id, room);

    expect(await store.get(room.id)).toEqual(room);
  });

  it('returns null for an unknown id', async () => {
    expect(await create().get('NOSUCHID')).toBeNull();
  });

  it('round-trips a room with no turn timer, which §5.3 offers as None', async () => {
    // `timerMs: null` is the **None** option in GDD §5.3, and every other room
    // in this file is built with a 5-minute timer — so without this row the
    // suite could not tell a store that honours None from one that refuses
    // every timerless room as corrupt on both the write and the read.
    const store = create();
    const room = makeRoom({ timerMs: null });

    await store.set(room.id, room);

    expect((await store.get(room.id))?.timerMs).toBeNull();
  });

  it('stores rooms by value, not by reference', async () => {
    const store = create();
    const room = makeRoom();
    await store.set(room.id, room);

    room.gameNumber = 99;
    const fetched = await store.get(room.id);
    expect(fetched?.gameNumber).toBe(1);

    if (fetched) fetched.gameNumber = 98;
    expect((await store.get(room.id))?.gameNumber).toBe(1);
  });

  it('overwrites on set', async () => {
    const store = create();
    const room = makeRoom();
    await store.set(room.id, room);
    await store.set(room.id, { ...room, version: 7, gameNumber: 3 });

    const fetched = await store.get(room.id);
    expect(fetched?.version).toBe(7);
    expect(fetched?.gameNumber).toBe(3);
  });

  describe('update', () => {
    it('applies the change, bumps the version and persists it', async () => {
      const store = create();
      const room = makeRoom({ version: 4 });
      await store.set(room.id, room);

      const returned = await store.update(
        room.id,
        (r) => ({ ...r, gameNumber: r.gameNumber + 1 }),
        4,
      );

      expect(returned.version).toBe(5);
      expect(returned.gameNumber).toBe(2);
      expect(await store.get(room.id)).toEqual(returned);
    });

    it('owns the version even if the callback sets one', async () => {
      const store = create();
      const room = makeRoom({ version: 4 });
      await store.set(room.id, room);

      const returned = await store.update(
        room.id,
        (r) => ({ ...r, version: 999 }),
        4,
      );

      expect(returned.version).toBe(5);
      expect((await store.get(room.id))?.version).toBe(5);
    });

    it('rejects a stale version and writes nothing', async () => {
      const store = create();
      const room = makeRoom({ version: 4 });
      await store.set(room.id, room);

      await expect(
        store.update(room.id, (r) => ({ ...r, gameNumber: 42 }), 3),
      ).rejects.toThrow(VersionConflictError);
      expect(await store.get(room.id)).toEqual(room);
    });

    it('reports the expected and actual versions on conflict', async () => {
      const store = create();
      const room = makeRoom({ version: 4 });
      await store.set(room.id, room);

      const error = await store
        .update(room.id, (r) => r, 2)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(VersionConflictError);
      expect(error).toMatchObject({
        roomId: room.id,
        expectedVersion: 2,
        actualVersion: 4,
      });
      // `name`, not just the class. `handlers.ts` renders
      // `${error.name}: ${error.message}` into the operator-facing failure
      // detail, so `name` is the only thing that tells the three store errors
      // apart in a log — and `this.name = '…'` → `'Error'` used to survive the
      // whole repo, leaving all three logged as an undifferentiated `Error:`.
      // The class assertion above cannot see it: `name` is a plain own
      // property, assigned in the constructor and writable by anyone.
      expect((error as Error).name).toBe('VersionConflictError');
    });

    it('spells out the conflict, because that message is a 409 body', async () => {
      // The API puts this string into the `/action` 409 response, so it is a
      // payload a person reads, not a log line: reducing it to "version
      // mismatch" is a user-visible change and has to fail here.
      const store = create();
      await store.set('ABCD2345', makeRoom({ version: 4 }));

      const conflict = await store
        .update('ABCD2345', (r) => r, 2)
        .catch((e: unknown) => e);
      expect((conflict as Error).message).toBe(
        'Room ABCD2345 is at version 4, not 2',
      );

      const missing = await create()
        .update('NOSUCHID', (r) => r, 1)
        .catch((e: unknown) => e);
      expect((missing as Error).message).toBe('Room NOSUCHID not found');
    });

    it('rejects an unknown room', async () => {
      const error = await create()
        .update('NOSUCHID', (r) => r, 1)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RoomNotFoundError);
      // `name` for the log line (see the conflict case above), and `roomId`
      // because it is the field that names the room: both siblings' extra
      // fields are asserted somewhere, and this one's was asserted nowhere, so
      // `this.roomId = roomId` → `''` survived the whole repo.
      expect((error as Error).name).toBe('RoomNotFoundError');
      expect(error).toMatchObject({ roomId: 'NOSUCHID' });
    });

    it('lets exactly one of two concurrent updates win', async () => {
      const store = create();
      const room = makeRoom({ version: 1, gameNumber: 0 });
      await store.set(room.id, room);

      // Both callers read version 1 and race to write version 2.
      const results = await Promise.allSettled([
        store.update(room.id, (r) => ({ ...r, gameNumber: 11 }), 1),
        store.update(room.id, (r) => ({ ...r, gameNumber: 22 }), 1),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0].reason).toBeInstanceOf(VersionConflictError);

      // The winner's write survives intact: the loser neither clobbered it nor
      // pushed the version past 2.
      const stored = await store.get(room.id);
      expect(stored).toEqual(won[0].value);
      expect(stored?.version).toBe(2);
      expect([11, 22]).toContain(stored?.gameNumber);
    });

    it('does not let a loser write over the winner in a longer chain', async () => {
      const store = create();
      const room = makeRoom({ version: 1, gameNumber: 0 });
      await store.set(room.id, room);

      await store.update(room.id, (r) => ({ ...r, gameNumber: 1 }), 1);
      await store.update(room.id, (r) => ({ ...r, gameNumber: 2 }), 2);

      await expect(
        store.update(room.id, (r) => ({ ...r, gameNumber: 99 }), 1),
      ).rejects.toThrow(VersionConflictError);
      expect((await store.get(room.id))?.gameNumber).toBe(2);
    });

    it('lets exactly one of three concurrent updates win', async () => {
      const store = create();
      const room = makeRoom({ version: 1, gameNumber: 0 });
      await store.set(room.id, room);

      // Two racers can be won by an implementation that simply serialises them.
      // Three cannot: the two losers both have to be told the same thing.
      const results = await Promise.allSettled(
        [11, 22, 33].map((gameNumber) =>
          store.update(room.id, (r) => ({ ...r, gameNumber }), 1),
        ),
      );

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(2);
      for (const loser of lost) {
        expect(loser.reason).toBeInstanceOf(VersionConflictError);
        expect(loser.reason).toMatchObject({
          expectedVersion: 1,
          actualVersion: 2,
        });
      }

      const stored = await store.get(room.id);
      expect(stored).toEqual(won[0].value);
      expect(stored?.version).toBe(2);
      expect([11, 22, 33]).toContain(stored?.gameNumber);
    });

    it('cannot be corrupted by an fn that mutates its argument and throws', async () => {
      const store = create();
      const room = makeRoom({ version: 1, gameNumber: 0 });
      await store.set(room.id, room);

      // A sentinel, asserted by identity: `toThrow('boom')` is a substring match,
      // so it cannot tell the caller's own error from a store error that merely
      // quotes it. `fn`'s exception is the caller's and must arrive unchanged.
      const boom = new Error('boom');
      const thrown = await store
        .update(
          room.id,
          (r) => {
            // Everything a careless caller might do to the object it was handed.
            r.gameNumber = 999;
            r.version = 999;
            r.players.W = 'hijacked';
            r.game.turn = 'B';
            throw boom;
          },
          1,
        )
        .catch((e: unknown) => e);
      // Identity, not class: `toBe` already fixes what arrived, so a
      // `not.toBeInstanceOf` after it is an assertion no value could fail.
      expect(thrown).toBe(boom);

      expect(await store.get(room.id)).toEqual(room);
    });

    it('detaches the room it handed fn, even after a successful write', async () => {
      const store = create();
      const room = makeRoom({ version: 1, gameNumber: 0 });
      await store.set(room.id, room);

      let handed: Room | null = null;
      const returned = await store.update(
        room.id,
        (r) => {
          handed = r;
          return { ...r, gameNumber: 5 };
        },
        1,
      );

      // Keep hold of both objects and scribble on them afterwards.
      (handed as unknown as Room).gameNumber = 4242;
      returned.gameNumber = 4243;

      expect((await store.get(room.id))?.gameNumber).toBe(5);
    });

    it('will not let fn rewrite the id the room is stored under', async () => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      const returned = await store.update(
        room.id,
        (r) => ({ ...r, id: 'HIJACKED' }),
        1,
      );

      expect(returned.id).toBe(room.id);
      expect((await store.get(room.id))?.id).toBe(room.id);
      expect(await store.get('HIJACKED')).toBeNull();
    });

    it('does not run fn at all when the version is already stale', async () => {
      const store = create();
      const room = makeRoom({ version: 4 });
      await store.set(room.id, room);

      let calls = 0;
      await expect(
        store.update(
          room.id,
          (r) => {
            calls++;
            return r;
          },
          3,
        ),
      ).rejects.toThrow(VersionConflictError);

      // Not because `fn` would throw — neither real caller's does — but because
      // "`fn` runs at most once, and never on a room the store already knows is
      // stale" is a property of `update`, not an accident of who calls it.
      expect(calls).toBe(0);
    });

    it('runs fn exactly once on a successful update', async () => {
      const store = create();
      const room = makeRoom({ version: 4 });
      await store.set(room.id, room);

      let calls = 0;
      await store.update(
        room.id,
        (r) => {
          calls++;
          return r;
        },
        4,
      );

      expect(calls).toBe(1);
    });

    /**
     * The return value is the thing both implementations have to agree on most:
     * it is what the API layer serialises into the 200 body. A store that hands
     * back `fn`'s own object has not been through JSON, so it disagrees with
     * what was stored, and disagrees with the other implementation.
     */
    it('returns the room that was stored, not the object fn built', async () => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      const freshGame: GameState = { ...room.game, turn: 'B' };
      const built = { ...room, game: freshGame, gameNumber: 9 };
      const returned = await store.update(room.id, () => built, 1);

      // Not the same objects, at the top level or nested.
      expect(returned).not.toBe(built);
      expect(returned.game).not.toBe(freshGame);
      expect(returned.game.board).not.toBe(freshGame.board);
      expect(returned).toEqual(await store.get(room.id));

      // Scribbling on fn's objects afterwards cannot reach the store or the
      // room the caller was handed.
      freshGame.turn = 'W';
      built.gameNumber = 4242;
      expect(returned.game.turn).toBe('B');
      expect((await store.get(room.id))?.gameNumber).toBe(9);
    });

    /**
     * `game` is checked field by field, not just `board`. `movesSinceRemoval`
     * is the one that bites: nulled, the engine's `movesSinceRemoval + 1` is
     * `1` forever after, so the 50-move draw clock never advances again for the
     * life of the room — seven days, on Redis.
     */
    it.each([
      ['movesSinceRemoval', { movesSinceRemoval: NaN }],
      ['turn', { turn: 42 }],
      ['phase', { phase: null }],
      ['pendingRemoval', { pendingRemoval: 'yes' }],
      ['hand', { hand: { W: NaN, B: 0 } }],
      ['lastMove', { lastMove: undefined }],
      ['lastMove.from', { lastMove: { from: 'edge', to: 3 } }],
      ['lastMove.to', { lastMove: { from: null, to: undefined } }],
      ['result.winner', { result: { winner: 7, reason: 'resign' } }],
      ['result.reason', { result: { winner: 'W', reason: undefined } }],
    ])(
      'refuses a game whose %s does not survive JSON, and writes nothing',
      async (_field, patch) => {
        const store = create();
        const room = makeRoom({ version: 1 });
        await store.set(room.id, room);

        await expect(
          store.update(
            room.id,
            (r) => ({ ...r, game: { ...r.game, ...patch } as GameState }),
            1,
          ),
        ).rejects.toThrow(CorruptRoomError);

        expect(await store.get(room.id)).toEqual(room);
      },
    );

    /**
     * The four string unions, checked by membership against the engine's own
     * `PLAYERS` / `PHASES` / `REASONS`. The engine derives its types from those
     * arrays, so this is one source of truth read twice, not copied.
     *
     * The first three cases are the critic's probes that used to round-trip:
     * a board of `'rook'`, an empty `turn`, and a `result` of
     * `{winner: 'zzz', reason: ''}`. The last is the empty `reason` that a
     * `DECISIONS.md` bullet claimed was refused for three passes while the code
     * only ever checked `typeof reason === 'string'`.
     */
    it.each([
      ['a board of pieces that are not pieces', { board: Array(POINT_COUNT).fill('rook') }],
      ['a board with one wrong cell', { board: [...initialState().board.slice(1), 'x'] }],
      ['an empty turn', { turn: '' }],
      ['a turn that is not a player', { turn: 'green' }],
      ['a phase the engine does not have', { phase: 'flying' }],
      ['a winner who is not a player', { result: { winner: 'zzz', reason: 'resign' } }],
      ['an empty reason', { result: { winner: 'W', reason: '' } }],
      ['a reason the engine cannot produce', { result: { winner: 'W', reason: 'banana' } }],
    ])('refuses %s', async (_name, patch) => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      await expect(
        store.update(
          room.id,
          (r) => ({ ...r, game: { ...r.game, ...patch } as GameState }),
          1,
        ),
      ).rejects.toThrow(CorruptRoomError);
      expect(await store.get(room.id)).toEqual(room);
    });

    it('accepts every literal the engine actually declares', async () => {
      // The other half: membership must not be so tight that a legitimate game
      // is refused. Every player, every phase, every reason, round-tripped.
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      let version = 1;
      for (const phase of PHASES) {
        for (const turn of PLAYERS) {
          for (const reason of REASONS) {
            for (const winner of [...PLAYERS, null]) {
              const next = await store.update(
                room.id,
                (r) => ({
                  ...r,
                  game: {
                    ...r.game,
                    board: r.game.board.map((_, i) =>
                      i === 0 ? 'W' : i === 1 ? 'B' : null,
                    ),
                    phase,
                    turn,
                    result: { winner, reason },
                  },
                }),
                version,
              );
              version = next.version;
              expect(next.game.result).toEqual({ winner, reason });
              expect(next.game.phase).toBe(phase);
            }
          }
        }
      }
      expect(version).toBe(1 + PHASES.length * PLAYERS.length * REASONS.length * 3);
    });

    it('accepts the legal shapes of lastMove and result', async () => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      const returned = await store.update(
        room.id,
        (r) => ({
          ...r,
          game: {
            ...r.game,
            lastMove: { from: null, to: 3 },
            result: { winner: null, reason: 'draw50' as const },
          },
        }),
        1,
      );

      expect(returned.game.lastMove).toEqual({ from: null, to: 3 });
      expect(returned.game.result).toEqual({ winner: null, reason: 'draw50' });
      expect(returned).toEqual(await store.get(room.id));
    });

    /**
     * A room carrying `NaN` used to be written, and then read back as `null`
     * against a field declared `number` — which on the Redis path bricked the
     * room for its whole 7-day TTL while the memory path kept serving it.
     * Rejecting at the door is the only resolution both paths can share.
     */
    it.each(['turnStartedAt', 'createdAt', 'gameNumber', 'timerMs'])(
      'refuses a room whose %s does not survive JSON, and writes nothing',
      async (field) => {
        const store = create();
        const room = makeRoom({ version: 1 });
        await store.set(room.id, room);

        await expect(
          store.update(room.id, (r) => ({ ...r, [field]: NaN }), 1),
        ).rejects.toThrow(CorruptRoomError);

        expect(await store.get(room.id)).toEqual(room);
      },
    );

    it('refuses a room with an own toJSON, rather than bricking it', async () => {
      // `toJSON` passes the pre-image check and then serialises to something
      // else entirely. Without the post-serialisation check the *write* is
      // accepted and every later `get` throws — on Redis, a 500 for the room's
      // whole 7-day TTL, which is worse than the rejection this asserts.
      const store = create();
      const room = makeRoom({ version: 1 });
      const hostile = { ...room, toJSON: () => 42 } as unknown as Room;

      await expect(store.set(room.id, hostile)).rejects.toThrow(CorruptRoomError);
      expect(await store.get(room.id)).toBeNull();
    });

    it('refuses a toJSON that rewrites the id, rather than filing it anyway', async () => {
      // The store owns `id`. A room serialising to a *different valid room* was
      // filed under one key while announcing another; it is now refused, not
      // quietly corrected, because the store cannot know what else that
      // serialisation changed.
      const store = create();
      const room = makeRoom({ version: 1 });
      const hijack = {
        ...room,
        toJSON: () => ({ ...room, id: 'HIJACKED' }),
      } as unknown as Room;

      await expect(store.set(room.id, hijack)).rejects.toThrow(CorruptRoomError);
      expect(await store.get(room.id)).toBeNull();
      expect(await store.get('HIJACKED')).toBeNull();
    });

    it.each([
      ['undefined', () => undefined],
      ['a function', () => () => 'nope'],
      ['a symbol', () => Symbol('nope')],
    ])('refuses a toJSON yielding %s with a store error, not a SyntaxError', async (
      _name,
      toJSON,
    ) => {
      // `JSON.stringify` returns the *value* undefined for these, and parsing
      // that throws a raw `SyntaxError` — indistinguishable, in an operator's
      // log, from a parser bug. Every sibling shape already gave
      // `CorruptRoomError`; these two did not.
      const store = create();
      const room = makeRoom({ version: 1 });
      const hostile = { ...room, toJSON } as unknown as Room;

      const error = await store.set(room.id, hostile).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CorruptRoomError);
      // Whole message. `not.toBeInstanceOf(SyntaxError)` used to stand here and
      // could not fail — `CorruptRoomError` is not a `SyntaxError` under any
      // mutation. What needs pinning is the `what` label: the same sentence is
      // produced for a room the caller handed in and for a value read back out
      // of Redis, and only this word says which.
      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: the room has no JSON form',
      );
      expect(await store.get(room.id)).toBeNull();
    });

    it('writes the bytes it validated, not a second call to toJSON', async () => {
      // Re-emitting from the parsed tree is load-bearing: serialising the
      // caller's object again would call `toJSON` again, and a `toJSON` that
      // answers differently each time would have one value validated and a
      // different one written — unvalidated.
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      let calls = 0;
      const flaky = (r: Room) =>
        ({
          ...r,
          toJSON: () => {
            calls += 1;
            return calls === 1
              ? { ...r, id: room.id, version: 2 }
              : { ...r, id: room.id, version: 2, phase: 'flying', game: { ...r.game, phase: 'flying' } };
          },
        }) as unknown as Room;

      await store.update(room.id, flaky, 1);

      // The validated first answer is what landed; the second was never written.
      const stored = await store.get(room.id);
      expect(stored?.game.phase).toBe(room.game.phase);
      expect(stored?.version).toBe(2);
    });

    it.each(['createdAt', 'turnStartedAt'])(
      'refuses a %s that is not a finite number',
      async (field) => {
        // `turnStartedAt` is the clock §5.3's forfeit claim is computed from, and
        // NaN round-trips to null — the turn timer silently switched off.
        // `typeof NaN === 'number'` is true, so a type check would let it past.
        const store = create();
        for (const bad of [NaN, Infinity, -Infinity]) {
          await expect(
            store.set('ABCD2345', makeRoom({ [field]: bad })),
          ).rejects.toThrow(CorruptRoomError);
        }
        expect(await store.get('ABCD2345')).toBeNull();
      },
    );

    it('refuses a NaN timestamp even when a toJSON would hide it', async () => {
      // The counter-example that makes `Number.isFinite` on the timestamps a
      // live guard rather than an equivalent mutant, which is how the previous
      // pass wrongly classified it. The argument for equivalence was that a NaN
      // survives to the post-image as `null` and is caught there — but that
      // assumes the emitted bytes come from the pre-image values, which is the
      // one assumption the post-image check exists to deny. With a `toJSON`
      // supplying a legal `createdAt`, a weakened pre-image check writes a room
      // the store never validated.
      const store = create();
      const room = makeRoom({ version: 1 });

      for (const field of ['createdAt', 'turnStartedAt'] as const) {
        const clean = { ...room, [field]: 1_700_000_000_000 };
        const hostile = {
          ...room,
          [field]: NaN,
          toJSON: () => clean,
        } as unknown as Room;

        await expect(store.set(room.id, hostile)).rejects.toThrow(
          CorruptRoomError,
        );
        expect(await store.get(room.id)).toBeNull();
      }
    });

    it.each([
      [
        'a cycle',
        () => {
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          return cyclic;
        },
      ],
      ['a bigint', () => BigInt(1)],
    ])('refuses a room carrying %s with a store error, not a TypeError', async (
      _name,
      make,
    ) => {
      // `JSON.stringify` *throws* on these, where a toJSON yielding undefined
      // makes it *return* undefined. Both used to escape the gate as something
      // an operator's log cannot tell from a bug in the store itself.
      //
      // The value goes in an *undeclared* field on purpose. It used to sit in
      // `players.W`, where the shape check refuses it as "players is not a pair
      // of tokens" before `JSON.stringify` is ever called — so this test passed
      // without once reaching the branch it names, which only an exact message
      // could show. An unknown field is the case the gate deliberately does not
      // inspect, so it is the one that leaves `JSON.stringify` to fail.
      const store = create();
      const room = makeRoom({ version: 1 });
      const hostile = { ...room, spare: make() } as unknown as Room;

      // What `JSON.stringify` itself says, quoted whole. `not.toBeInstanceOf(
      // TypeError)` used to stand here and could not fail; this asserts the one
      // thing that actually distinguishes a wrapped failure from a lost one —
      // that the `TypeError`'s own words survive into the store's message.
      let raised = '';
      try {
        JSON.stringify(hostile);
      } catch (e) {
        raised = (e as Error).message;
      }
      expect(raised).not.toBe('');

      const error = await store.set(room.id, hostile).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toBe(
        `Room ABCD2345 is not readable: the room cannot be serialised (${raised})`,
      );
      expect(await store.get(room.id)).toBeNull();
    });

    it('refuses an unserialisable room from update too', async () => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      await expect(
        store.update(
          room.id,
          (r) => ({ ...r, toJSON: () => cyclic }) as unknown as Room,
          1,
        ),
      ).rejects.toThrow(CorruptRoomError);
      expect((await store.get(room.id))?.version).toBe(1);
    });

    it.each([
      [
        'a getter that throws on a declared field',
        (room: Room) => {
          const hostile = { ...room };
          Object.defineProperty(hostile, 'version', {
            get() {
              throw new Error('boom');
            },
            enumerable: true,
          });
          return hostile;
        },
      ],
      [
        'a proxy that throws on any read',
        (room: Room) =>
          new Proxy(room, {
            get() {
              throw new Error('boom');
            },
          }),
      ],
    ])('refuses %s with a store error, not a raw TypeError', async (_n, make) => {
      // Validating a room means reading its fields, and that read can throw.
      // A throwing getter on an *undeclared* field was already reported properly
      // — only `JSON.stringify` reached it — while one on `version` or `game`
      // escaped verbatim.
      const store = create();
      const room = makeRoom({ version: 1 });

      const setError = await store
        .set(room.id, make(room) as Room)
        .catch((e: unknown) => e);
      expect(setError).toBeInstanceOf(CorruptRoomError);
      expect(await store.get(room.id)).toBeNull();

      await store.set(room.id, room);
      await expect(
        store.update(room.id, (r) => make(r) as Room, 1),
      ).rejects.toThrow(CorruptRoomError);
      expect((await store.get(room.id))?.version).toBe(1);
    });

    it('refuses a getter that throws only on its second read', async () => {
      // Where the `version` read that the post-image is compared against sits.
      // It is taken *inside* the read guard, next to the validation, rather than
      // repeated after serialising — a getter is entitled to throw on its second
      // read as easily as its first. Every other hostile-getter case here throws
      // on *every* read, so the validator's first read throws and no second read
      // is ever reached, which leaves that placement unpinned. This getter
      // answers once and then throws, so it reaches whichever read comes next,
      // and the message says which one that was.
      const store = create();
      const room = makeRoom({ version: 1 });

      let reads = 0;
      const hostile = { ...room };
      Object.defineProperty(hostile, 'version', {
        get() {
          reads += 1;
          if (reads > 1) throw new Error('boom');
          return 1;
        },
        enumerable: true,
      });

      const error = await store
        .set(room.id, hostile as Room)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: the room could not be read (boom)',
      );
      expect(await store.get(room.id)).toBeNull();
    });

    it('refuses a getter whose second read is a value no template can print', async () => {
      // The sibling of the test above, and the fourth instance of "an error path
      // reads a caller-controlled value directly". A getter need not *throw* on
      // its second read to defeat this: it can answer with a value that throws
      // when the message is built. `given` is that second read, and it is
      // interpolated into the CAS-defeat message from *outside* `guardingReads`,
      // so `${given}` on a symbol threw `TypeError: Cannot convert a Symbol value
      // to a string` — a raw `TypeError` out of `set` and `update` on both
      // implementations, none of the three types `RoomStore.update` promises.
      // The getter answers 1 for the validator, a symbol for `given`, and 1 again
      // for `JSON.stringify`, so the post-image is a well-formed room and the
      // version comparison is genuinely reached.
      const store = create();
      const room = makeRoom({ version: 1 });

      let reads = 0;
      const hostile = { ...room };
      Object.defineProperty(hostile, 'version', {
        get() {
          reads += 1;
          return reads === 2 ? (Symbol('nope') as unknown as number) : 1;
        },
        enumerable: true,
      });

      const error = await store
        .set(room.id, hostile as Room)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: serialising the room changed version from Symbol(nope) to 1',
      );
      expect(await store.get(room.id)).toBeNull();
    });

    it('describes a value the message builder itself cannot stringify', async () => {
      // `JSON.stringify` throws on a bigint, so building the *message* threw and
      // the gate could not report the one thing it had detected.
      const store = create();
      const error = await store
        .set('ABCD2345', BigInt(1) as unknown as Room)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toContain('bigint');
    });

    it('names a value that has no JSON form, rather than calling it undefined', async () => {
      // Pins the `?? String(value)` fallback in the message builder: without it
      // this reads "value is undefined", which says nothing about what arrived.
      const store = create();
      const error = await store
        .set('ABCD2345', (() => 1) as unknown as Room)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toContain('() => 1');
    });

    it.each<[string, unknown, string]>([
      ['a bigint', BigInt(7), 'a bigint with no JSON form'],
      ['a symbol', Symbol('hijack'), 'Symbol(hijack)'],
    ])('names an id that is %s, rather than failing to describe it', async (
      _name,
      id,
      rendered,
    ) => {
      // The id-disagreement message used `JSON.stringify` on a caller-controlled
      // value — the exact defect `describeValue` was written for, in a third
      // place. A bigint made the *message builder* throw, so the room was
      // reported as `the room could not be read (Do not know how to serialize a
      // BigInt)` — a serialisation complaint for what is an id disagreement — and
      // a symbol rendered as `room announces id undefined`, saying nothing about
      // what arrived. The room is refused either way; what was wrong was what the
      // operator got told. `toContain('HIJACKED')` below cannot see any of this,
      // because a string id renders identically under both.
      const store = create();
      const error = await store
        .set('ABCD2345', makeRoom({ id: id as string }))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toBe(
        `Room ABCD2345 is not readable: room announces id ${rendered}`,
      );
      expect(await store.get('ABCD2345')).toBeNull();
    });

    it('refuses a version at which the compare-and-set would stop working', async () => {
      // `9007199254740992 + 1 === 9007199254740992`. A room set at or above 2^53
      // makes `update` write back the version it read, so the CAS never sees a
      // change and every later `update` pinned to that version wins — two
      // writers committing from one version, which is the one thing this store
      // exists to prevent. Only this gate stands between `set` and that hole.
      const store = create();

      await expect(
        store.set('ABCD2345', makeRoom({ version: 2 ** 53 })),
      ).rejects.toThrow(CorruptRoomError);
      expect(await store.get('ABCD2345')).toBeNull();

      // The last version that still works is accepted, and updating *it* fails
      // loudly rather than silently degrading into a no-op.
      await store.set('ABCD2345', makeRoom({ version: Number.MAX_SAFE_INTEGER }));
      await expect(
        store.update('ABCD2345', (r) => r, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow(CorruptRoomError);
      expect((await store.get('ABCD2345'))?.version).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    class NastyError extends Error {
      get message(): string {
        throw new Error('reading the message threw');
      }
    }

    it.each([
      ['null', null, 'null'],
      ['undefined', undefined, 'undefined'],
      ['a plain string', 'a plain string', '"a plain string"'],
      ['a number', 42, '42'],
      // An `Error` whose own `message` cannot be read. `(cause as Error).message`
      // throws here, and `JSON.stringify` of an Error is `{}`, which names
      // nothing — so neither the guard nor the fallback may be skipped.
      ['an Error with a throwing message getter', new NastyError(), 'an unreadable Error'],
      [
        'an Error whose message has a throwing toString',
        Object.assign(new Error(), {
          message: {
            toString() {
              throw new Error('stringifying the message threw');
            },
          },
        }),
        'an unreadable Error',
      ],
      [
        'an Error subclass with a throwing message getter',
        Object.assign(new NastyError(), { name: 'CustomFailure' }),
        'an unreadable CustomFailure',
      ],
      // `name` is as writable as `message`, so it need not be a string either.
      // Without the `typeof name === 'string'` arm this renders "an unreadable
      // 42" — or, for a name whose own getter throws, "an unreadable undefined",
      // which is the exact emptiness the fallback exists to avoid.
      [
        'an Error whose name is a number',
        Object.assign(new NastyError(), { name: 42 }),
        'an unreadable Error',
      ],
      [
        'an Error whose name getter throws too',
        Object.defineProperty(new NastyError(), 'name', {
          get() {
            throw new Error('reading the name threw');
          },
        }),
        'an unreadable Error',
      ],
      // Every row above has a readable prototype, so none of them can tell "the
      // cause is read through `tried`" from "the cause is read directly" — a bare
      // `cause instanceof Error` in `reason` passed all of them, and so did the
      // bare `cause instanceof CorruptRoomError` in `guardingReads`, which was a
      // live defect: a `Proxy` trapping `getPrototypeOf` made the guard written to
      // stop raw exceptions escaping throw a raw `Error: boom` itself, out of
      // `set` and `update` on both implementations. `instanceof` invokes
      // `[[GetPrototypeOf]]`, so a type test is a read like any other. The proxy
      // traps nothing else, so `JSON.stringify` still renders it `{}`.
      [
        'a value whose prototype cannot be read',
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('boom');
            },
          },
        ),
        '{}',
      ],
    ])('reports a caller that throws %s, without throwing itself', async (
      _label,
      thrown,
      rendered,
    ) => {
      // `throw null` and `throw undefined` made `(cause as Error).message` throw
      // a TypeError out of the error path itself; a string cause rendered as
      // "undefined", saying nothing about what arrived.
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      // Each site is paired with the exact message it must produce. The `what`
      // label threaded through the guards is what distinguishes them, and one
      // `.+` pattern let a constant label pass for all three.
      const sites: [
        make: (r: Room) => Room,
        fromSetWhat: string,
        fromUpdateWhat: string,
      ][] = [
        [
          (r) => {
            const hostile = { ...r };
            Object.defineProperty(hostile, 'version', {
              get() {
                throw thrown;
              },
              enumerable: true,
            });
            return hostile;
          },
          'the room could not be read',
          'the next room could not be read',
        ],
        [
          (r) =>
            new Proxy(r, {
              get() {
                throw thrown;
              },
            }),
          'the room could not be read',
          'the next room could not be read',
        ],
        [
          (r) =>
            ({
              ...r,
              toJSON: () => {
                throw thrown;
              },
            }) as unknown as Room,
          'the room cannot be serialised',
          'the room cannot be serialised',
        ],
      ];

      for (const [make, fromSetWhat, fromUpdateWhat] of sites) {
        const fromSet = await store
          .set(room.id, make(room))
          .catch((e: unknown) => e);
        expect(fromSet).toBeInstanceOf(CorruptRoomError);
        expect((fromSet as Error).message).toBe(
          `Room ABCD2345 is not readable: ${fromSetWhat} (${rendered})`,
        );

        const fromUpdate = await store
          .update(room.id, make, 1)
          .catch((e: unknown) => e);
        expect(fromUpdate).toBeInstanceOf(CorruptRoomError);
        expect((fromUpdate as Error).message).toBe(
          `Room ABCD2345 is not readable: ${fromUpdateWhat} (${rendered})`,
        );
      }

      expect((await store.get(room.id))?.version).toBe(1);
    });

    it('reports a validation failure once, not wrapped in itself', async () => {
      // The `CorruptRoomError` re-throw in the read guard is on the hot path:
      // every write-path validation failure passes through it, and without it
      // they are all double-wrapped. Every message assertion in this suite was
      // `toContain`, which cannot see that, so this one is exact.
      const store = create();
      const error = await store
        .set('ABCD2345', makeRoom({ version: 1.5 }))
        .catch((e: unknown) => e);

      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: version is not a whole count',
      );
    });

    it('refuses a toJSON that rewrites the version', async () => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      // Asserted whole. The two version numbers are the only operator-facing
      // evidence that a `toJSON` tried to defeat the compare-and-set, and
      // `/version/` went on matching with both of them dropped from the
      // sentence. `update` supplies the version, so the value that went in is
      // 2 — the version this write would have carried — while the bytes claimed
      // 999.
      const error = await store
        .update(
          room.id,
          (r) => ({ ...r, toJSON: () => ({ ...r, version: 999 }) }) as unknown as Room,
          1,
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: serialising the room changed version from 2 to 999',
      );
      expect((await store.get(room.id))?.version).toBe(1);
    });

    it('cannot have its compare-and-set defeated by a toJSON', async () => {
      // The reproduction: serialising to `version: 1` let three successive
      // `update(id, fn, 1)` calls all succeed, each clobbering the last, because
      // `update` set the version on the pre-image and `toJSON` decided the
      // bytes. Lost-update prevention is the one thing this store is for.
      const store = create();
      const room = makeRoom({ version: 1, gameNumber: 0 });
      await store.set(room.id, room);

      const pinned = (n: number) => (r: Room) =>
        ({
          ...r,
          gameNumber: n,
          toJSON: () => ({ ...r, gameNumber: n, version: 1 }),
        }) as unknown as Room;

      for (const n of [1, 2, 3]) {
        await expect(store.update(room.id, pinned(n), 1)).rejects.toThrow(
          CorruptRoomError,
        );
      }

      const stored = await store.get(room.id);
      expect(stored?.version).toBe(1);
      expect(stored?.gameNumber).toBe(0);
    });

    it.each([
      ['to at the first point off the board', { from: null, to: POINT_COUNT }],
      ['from at the first point off the board', { from: POINT_COUNT, to: 3 }],
    ])('refuses a lastMove with %s', async (_name, lastMove) => {
      // The boundary the range check exists for: `lastMove.to === 24` would read
      // `board[24] === undefined` in the UI. The other probes are all far from
      // it, so `< POINT_COUNT` mutated to `<=` used to survive the whole suite.
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      await expect(
        store.update(
          room.id,
          (r) => ({ ...r, game: { ...r.game, lastMove } }),
          1,
        ),
      ).rejects.toThrow(CorruptRoomError);
    });

    it('accepts a lastMove on the last point of the board', async () => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      const returned = await store.update(
        room.id,
        (r) => ({
          ...r,
          game: { ...r.game, lastMove: { from: POINT_COUNT - 1, to: 0 } },
        }),
        1,
      );
      expect(returned.game.lastMove).toEqual({ from: POINT_COUNT - 1, to: 0 });
    });

    it('refuses a sparse board, which JSON would quietly empty', async () => {
      // `new Array(24)` has length 24, and `Array.prototype.every` skips holes,
      // so it passed the cell test — then `JSON.stringify` turned every hole
      // into `null` and the board came back empty.
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      await expect(
        store.update(
          room.id,
          (r) => ({
            ...r,
            game: { ...r.game, board: new Array(POINT_COUNT) as Cell[] },
          }),
          1,
        ),
      ).rejects.toThrow(CorruptRoomError);

      expect((await store.get(room.id))?.game.board).toEqual(room.game.board);
    });

    it.each(['gameNumber'])(
      'refuses a fractional or negative %s',
      async (field) => {
        const store = create();
        await expect(
          store.set('ABCD2345', makeRoom({ [field]: 2.5 })),
        ).rejects.toThrow(/whole count/);
        await expect(
          store.set('ABCD2345', makeRoom({ [field]: -1 })),
        ).rejects.toThrow(/whole count/);
      },
    );

    it.each([
      ['a hand that is fractional', { hand: { W: 1.75, B: 1 } }],
      ['a hand that is negative', { hand: { W: -5, B: 1 } }],
      ['a movesSinceRemoval that is fractional', { movesSinceRemoval: -3.5 }],
      ['a lastMove.to off the board', { lastMove: { from: null, to: 99 } }],
      ['a lastMove.from off the board', { lastMove: { from: -12, to: 3 } }],
      ['a lastMove.to that is fractional', { lastMove: { from: null, to: 2.5 } }],
    ])('refuses %s — checkable without copying the engine', async (_n, patch) => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      await expect(
        store.update(
          room.id,
          (r) => ({ ...r, game: { ...r.game, ...patch } as GameState }),
          1,
        ),
      ).rejects.toThrow(CorruptRoomError);
      expect(await store.get(room.id)).toEqual(room);
    });

    /**
     * The `isObject` conjunct in `isSeatMap`, which gates four fields —
     * `players`, `rematch`, `drawOffer` and `game.hand`. Dropping it (`ok(v?.W)
     * && ok(v?.B)`) survived the whole suite: an array carrying `W`/`B` is
     * structurally assignable to `{ W; B }`, so it needs no cast to reach
     * `Room`, its `.W`/`.B` are the values the pair check wants, and a `toJSON`
     * repairs the post-image. The write then lands, and the store holds a room
     * whose shape did not survive the round trip — the one thing this gate
     * exists to prevent.
     */
    it.each<[field: string, make: () => Room, message: string]>([
      [
        'players',
        () => makeRoom({ players: arraySeats<string | null>('token-w', null) }),
        'players is not a pair of tokens',
      ],
      ...(['rematch', 'drawOffer'] as const).map(
        (field): [string, () => Room, string] => [
          field,
          () => makeRoom({ [field]: arraySeats(false, false) }),
          `${field} is not a pair of flags`,
        ],
      ),
      [
        'game.hand',
        () => makeRoom({ game: { ...initialState(), hand: arraySeats(9, 9) } }),
        'game.hand is not a pair of whole counts',
      ],
    ])(
      'refuses a %s that is an array wearing the seats, and writes nothing',
      async (_field, make, message) => {
        const store = create();
        const error = await store
          .set('ABCD2345', make())
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(CorruptRoomError);
        expect((error as Error).message).toBe(
          `Room ABCD2345 is not readable: ${message}`,
        );
        expect(await store.get('ABCD2345')).toBeNull();
      },
    );

    /**
     * The last of the five `isObject` call sites, in `whyNotAGameState`'s
     * `result` arm — the one no other row covers. Weakened to `result === undefined`
     * it passed the whole suite: the only fixture that reached the guard was
     * `result: undefined`, which the mutant refuses identically, so the guard
     * itself never fired. Under the mutant this write lands, and the store
     * holds a room whose `game.result` did not survive the round trip.
     */
    it('refuses a result that is an array wearing the fields, and writes nothing', async () => {
      const store = create();
      const error = await store
        .set(
          'ABCD2345',
          makeRoom({
            game: { ...initialState(), result: arrayResult('W', 'resign') },
          }),
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      // The third `name`. The API layer renders `${error.name}: ${error.message}`
      // into its operator log, so all three are checked here beside each other
      // rather than relying on a test in another item to notice.
      expect((error as Error).name).toBe('CorruptRoomError');
      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: game.result is neither a result nor null',
      );
      expect(await store.get('ABCD2345')).toBeNull();
    });

    it('refuses a fractional version, which Lua would truncate', async () => {
      // The memory path compares and reports 1.5; Redis returns it through
      // Lua's integer conversion, which truncates to 1 — so the two would
      // disagree about `actualVersion` for the same room.
      const store = create();
      await expect(
        store.set('ABCD2345', makeRoom({ version: 1.5 })),
      ).rejects.toThrow(/version is not a whole count/);
      await expect(
        store.set('ABCD2345', makeRoom({ version: -1 })),
      ).rejects.toThrow(/version is not a whole count/);
    });

    it('discards a NaN version from fn, because the store owns it', async () => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      const returned = await store.update(
        room.id,
        (r) => ({ ...r, version: NaN }),
        1,
      );
      expect(returned.version).toBe(2);
    });

    it('refuses a room whose board is not the engine board', async () => {
      const store = create();
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      await expect(
        store.update(
          room.id,
          (r) => ({ ...r, game: { ...r.game, board: [null, null] } }),
          1,
        ),
      ).rejects.toThrow(CorruptRoomError);
      expect(await store.get(room.id)).toEqual(room);
    });

    /**
     * The documented misuse from `RoomStore.set`. Neither implementation can
     * reject it — a `set` leaves `version` alone, so the compare-and-set has
     * nothing to catch it by — but both must at least resolve it the same way,
     * or a bug reproduces in dev and vanishes in production, or the reverse.
     */
    it('resolves a set interleaved with an update the same way on both paths', async () => {
      const store = create();
      const room = makeRoom({ version: 1, gameNumber: 0 });
      await store.set(room.id, room);

      // Started, not awaited: the update is now parked between its read and its
      // write on both implementations.
      const updating = store.update(
        room.id,
        (r) => ({ ...r, gameNumber: 11 }),
        1,
      );
      await store.set(room.id, { ...room, version: 1, gameNumber: 77 });
      const returned = await updating;

      // The update completes and the interleaved set is lost — on both.
      expect(returned.gameNumber).toBe(11);
      expect(returned.version).toBe(2);
      const stored = await store.get(room.id);
      expect(stored).toEqual(returned);
      expect(stored?.gameNumber).toBe(11);
    });
  });

  it('lets a version-moving interleaved set beat the update, on both paths', async () => {
    const store = create();
    const room = makeRoom({ version: 1, gameNumber: 0 });
    await store.set(room.id, room);

    // The other half of the misuse: a `set` that *moves* the version is visible
    // to the compare-and-set, so the update loses instead of winning.
    const updating = store.update(
      room.id,
      (r) => ({ ...r, gameNumber: 11 }),
      1,
    );
    await store.set(room.id, { ...room, version: 5, gameNumber: 77 });

    const error = await updating.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VersionConflictError);
    expect(error).toMatchObject({ expectedVersion: 1, actualVersion: 5 });

    const stored = await store.get(room.id);
    expect(stored?.version).toBe(5);
    expect(stored?.gameNumber).toBe(77);
  });

  it('refuses a room whose id disagrees with the key, rather than correcting it', async () => {
    // One policy for the store-owned fields on both sides of the serialisation.
    // This used to be silently rewritten on the way in while a `toJSON` that
    // changed the same field on the way out was refused.
    const store = create();

    await expect(
      store.set('ABCD2345', makeRoom({ id: 'ELSEWHERE' })),
    ).rejects.toThrow(CorruptRoomError);
    expect(await store.get('ABCD2345')).toBeNull();
    expect(await store.get('ELSEWHERE')).toBeNull();
  });

  it('still lets update supply the id, which is not the same thing', async () => {
    // `update` does not *correct* the store-owned fields, it *supplies* them —
    // exactly as `RoomStore.update` says — so an `fn` that returns a different
    // id is overwritten, not refused, the same as it is for `version`.
    const store = create();
    const room = makeRoom({ version: 1 });
    await store.set(room.id, room);

    const returned = await store.update(
      room.id,
      (r) => ({ ...r, id: 'HIJACKED', version: 999 }),
      1,
    );

    expect(returned.id).toBe(room.id);
    expect(returned.version).toBe(2);
    expect(await store.get('HIJACKED')).toBeNull();
  });

  /**
   * Replaces a test that asserted the opposite — that a NaN `movesSinceRemoval`
   * was written through as `null` — while its neighbour asserted a NaN
   * `timerMs` was refused. Both were green; only one can be the contract.
   */
  it('refuses a room whose game would not survive JSON, on set as well', async () => {
    const store = create();
    const room = makeRoom();

    await expect(
      store.set(room.id, {
        ...room,
        game: { ...room.game, movesSinceRemoval: NaN },
      }),
    ).rejects.toThrow(CorruptRoomError);

    expect(await store.get(room.id)).toBeNull();
  });
});

describe('RedisStore with a client that deserializes for us', () => {
  /** The object the client itself holds — the thing that must not escape. */
  function held(overrides: Partial<Room> = {}) {
    const client = new FakeRedis();
    const object = { ...makeRoom({ version: 1 }), ...overrides };
    // The script still needs a stored value to compare against; only `get` is
    // made to hand back the client's own object.
    client.values.set(roomKey('ABCD2345'), JSON.stringify(makeRoom({ version: 1 })));
    client.get = async () => object;
    return { client, object, store: new RedisStore(client) };
  }

  it('does not hand back the client’s own object', async () => {
    const { object, store } = held();
    const got = await store.get('ABCD2345');

    // `toEqual` passed all along; identity is what was never checked.
    expect(got).toEqual(object);
    expect(got).not.toBe(object);
    expect(got?.game).not.toBe(object.game);
    expect(got?.game.board).not.toBe(object.game.board);
    expect(got?.players).not.toBe(object.players);
  });

  it('does not let a caller mutate the store through what get returned', async () => {
    const { store } = held();
    const got = await store.get('ABCD2345');
    got!.gameNumber = 4242;
    got!.game.board[0] = 'W';

    const again = await store.get('ABCD2345');
    expect(again?.gameNumber).toBe(1);
    expect(again?.game.board[0]).toBeNull();
  });

  it('does not let update’s fn reach into the client’s object', async () => {
    const { object, store } = held();
    await store.update(
      'ABCD2345',
      (r) => {
        r.gameNumber = 4242;
        r.game.board[0] = 'W';
        return r;
      },
      1,
    );

    expect(object.gameNumber).toBe(1);
    expect(object.game.board[0]).toBeNull();
  });

  it('does not let a throwing fn leave its damage on the client’s object', async () => {
    // The case `RoomStore.update` promises cannot happen: "mutating it, or
    // throwing after mutating it, cannot reach the stored room".
    const { object, store } = held();
    await expect(
      store.update(
        'ABCD2345',
        (r) => {
          r.players.W = 'hijacked';
          throw new Error('boom');
        },
        1,
      ),
    ).rejects.toThrow('boom');

    expect(object.players.W).toBe('token-w');
  });

  it('refuses a value MemoryStore could never return', async () => {
    // A `Date` survives `structuredClone` and never survives JSON, so it could
    // reach the app from Redis and never from memory.
    const { store } = held({ turnStartedAt: new Date(1) as unknown as number });
    await expect(store.get('ABCD2345')).rejects.toThrow(CorruptRoomError);
  });
});

describe('RedisStore', () => {
  it('keys rooms as room:{id}', async () => {
    const client = new FakeRedis();
    const store = new RedisStore(client);
    const room = makeRoom();

    await store.set(room.id, room);

    expect(roomKey(room.id)).toBe('room:ABCD2345');
    expect([...client.values.keys()]).toEqual(['room:ABCD2345']);
  });

  it('sets a 7-day TTL on every write', async () => {
    const client = new FakeRedis();
    const store = new RedisStore(client);
    const room = makeRoom();

    await store.set(room.id, room);

    expect(ROOM_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(client.ttls.get(roomKey(room.id))).toBe(ROOM_TTL_SECONDS);
  });

  it('refreshes the TTL on update', async () => {
    const client = new FakeRedis();
    const store = new RedisStore(client);
    const room = makeRoom();
    await store.set(room.id, room);

    // Simulate the key having aged most of the way to expiry.
    client.ttls.set(roomKey(room.id), 30);
    await store.update(room.id, (r) => r, room.version);

    expect(client.ttls.get(roomKey(room.id))).toBe(ROOM_TTL_SECONDS);
    expect(client.frames[0].at(-1)).toBe(String(ROOM_TTL_SECONDS));
  });

  it('rejects a write whose room vanished between the read and the script', async () => {
    const client = new FakeRedis();
    const store = new RedisStore(client);
    const room = makeRoom();
    await store.set(room.id, room);

    client.onBeforeEval = () => client.values.delete(roomKey(room.id));

    await expect(store.update(room.id, (r) => r, room.version)).rejects.toThrow(
      RoomNotFoundError,
    );
  });

  it.each<[string, string]>([
    ['bytes that are not JSON at all', '{not json'],
    ['an empty value, as a plain SET would leave it', ''],
    ['valid JSON that is not an object', '42'],
    ['a JSON null', 'null'],
    ['a JSON array', '[1, 2]'],
    ['an object with no version', '{"id":"ABCD2345"}'],
    ['an object whose version is a string', '{"id":"ABCD2345","version":"1"}'],
  ])(
    'reports %s written inside the CAS window as a corrupt room',
    async (_name, planted) => {
      // The one window the compare-and-set exists for, and the contract on
      // `RoomStore.update` names `CorruptRoomError` for it. Redis used to answer
      // it two other ways, neither carrying `roomId` and neither one of the
      // three promised types: `cjson.decode` *raises* on the first two, which
      // arrives as an `UpstashError`, and a value with no numeric `version`
      // made `return {0, room.version}` a one-element table, so the caller got
      // `Error: Unexpected result from the room update script: [0]`.
      const client = new FakeRedis();
      const store = new RedisStore(client);
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);

      client.onBeforeEval = () => {
        client.onBeforeEval = null;
        client.values.set(roomKey(room.id), planted);
      };

      const error = await store
        .update(room.id, (r) => r, 1)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: the stored value stopped being a room between the read and the write',
      );
      expect(error).toMatchObject({ roomId: 'ABCD2345' });
      // And the corrupt value is left exactly as it was found: the script
      // refuses before its `SET`, so nothing overwrites the evidence.
      expect(client.values.get(roomKey(room.id))).toBe(planted);
    },
  );

  it('rejects a write when another writer lands between the read and the script', async () => {
    const client = new FakeRedis();
    const store = new RedisStore(client);
    const room = makeRoom({ version: 1, gameNumber: 0 });
    await store.set(room.id, room);

    // The store has already read version 1 and is about to compare-and-set; a
    // concurrent writer commits version 2 first.
    client.onBeforeEval = () => {
      client.onBeforeEval = null;
      client.values.set(
        roomKey(room.id),
        JSON.stringify({ ...room, version: 2, gameNumber: 77 }),
      );
    };

    const error = await store
      .update(room.id, (r) => ({ ...r, gameNumber: 11 }), 1)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VersionConflictError);
    expect(error).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
    // The concurrent write stands, unclobbered.
    expect(await store.get(room.id)).toMatchObject({
      version: 2,
      gameNumber: 77,
    });
  });

  it('puts the documented EVAL frame on the wire', async () => {
    const client = new FakeRedis();
    const store = new RedisStore(client);
    const room = makeRoom({ version: 3 });
    await store.set(room.id, room);

    const next = await store.update(
      room.id,
      (r) => ({ ...r, gameNumber: 5 }),
      3,
    );

    // `["eval", script, numkeys, ...keys, ...args]` — one key, three arguments.
    expect(client.frames).toEqual([
      [
        'eval',
        UPDATE_SCRIPT,
        1,
        'room:ABCD2345',
        JSON.stringify(next),
        '3',
        String(ROOM_TTL_SECONDS),
      ],
    ]);
  });

  it('throws on an unrecognisable script result', async () => {
    const client = new FakeRedis();
    const store = new RedisStore(client);
    const room = makeRoom();
    await store.set(room.id, room);
    client.eval = async () => 'nonsense';

    await expect(store.update(room.id, (r) => r, room.version)).rejects.toThrow(
      /update script/,
    );
  });

  describe('a stored value that is not a room', () => {
    const stored = (value: unknown): FakeRedis => {
      const client = new FakeRedis();
      client.values.set(
        roomKey('ABCD2345'),
        typeof value === 'string' ? value : JSON.stringify(value),
      );
      return client;
    };

    const noVersion: Record<string, unknown> = { ...makeRoom() };
    delete noVersion.version;
    // V8's words, computed rather than transcribed: they change between Node
    // versions, and this row asserts the whole sentence like every other one.
    const parserSaid = ((): string => {
      try {
        JSON.parse('{not json');
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    // Each row carries the **whole** refusal, not just the class, because the
    // class cannot say which guard fired — and a fixture several guards refuse
    // pins none of them by class alone. Every row below is either refused by
    // exactly one guard or names the guard that gets there first.
    const cases: [name: string, value: unknown, detail: string][] = [
      ['a bare number', '42', 'value is 42'],
      ['a bare string', '"just a string"', 'value is "just a string"'],
      ['null inside a JSON string', 'null', 'value is null'],
      ['an array', '[]', 'value is []'],
      ['unparseable JSON', '{not json', `value is not JSON (${parserSaid})`],
      ['a room with no version', noVersion, 'version is not a whole count'],
      [
        'a room whose version is a string',
        { ...makeRoom(), version: '4' },
        'version is not a whole count',
      ],
      [
        'a room whose version is NaN-shaped',
        { ...makeRoom(), version: null },
        'version is not a whole count',
      ],
      [
        'a room with no players',
        { ...makeRoom(), players: undefined },
        'players is not a pair of tokens',
      ],
      [
        'a room whose players are not tokens',
        { ...makeRoom(), players: { W: 7, B: null } },
        'players is not a pair of tokens',
      ],
      [
        'a room whose Black token is not a token',
        { ...makeRoom(), players: { W: 'w', B: 7 } },
        'players is not a pair of tokens',
      ],
      [
        'a room with no Black seat at all',
        { ...makeRoom(), players: { W: 'w' } },
        'players is not a pair of tokens',
      ],
      [
        'a room whose Black rematch flag is not a flag',
        { ...makeRoom(), rematch: { W: false, B: 'no' } },
        'rematch is not a pair of flags',
      ],
      [
        'a room whose Black draw offer is missing',
        { ...makeRoom(), drawOffer: { W: false } },
        'drawOffer is not a pair of flags',
      ],
      [
        'a room whose Black hand is not a count',
        { ...makeRoom(), game: { ...initialState(), hand: { W: 9, B: 'nine' } } },
        'game.hand is not a pair of whole counts',
      ],
      [
        'a room with no game',
        { ...makeRoom(), game: undefined },
        'game is not a game state',
      ],
      // Not `12345`: `==` refuses that as readily as `===`, so the row named for
      // the id check could not see the check weakened to `==`. An array whose
      // one element is the key coerces to the key itself, so `==` accepts it —
      // and `whyNotARoom` never looks at `id`, which makes this comparison the
      // only thing that types `Room.id` as a string at all.
      [
        'a room whose id is an array that coerces to the key',
        { ...makeRoom(), id: ['ABCD2345'] },
        'room announces id ["ABCD2345"]',
      ],
      [
        'a room whose timerMs is neither number nor null',
        { ...makeRoom(), timerMs: 'fast' },
        'timerMs is neither a number nor null',
      ],
      [
        'a room whose game is empty',
        { ...makeRoom(), game: {} },
        `game.board is not ${POINT_COUNT} points`,
      ],
      [
        'a room whose game has no board',
        { ...makeRoom(), game: { turn: 'W' } },
        `game.board is not ${POINT_COUNT} points`,
      ],
      [
        'a room whose board is a string',
        { ...makeRoom(), game: { board: 'nope' } },
        `game.board is not ${POINT_COUNT} points`,
      ],
      [
        'a room whose board is too short',
        { ...makeRoom(), game: { board: [null, null] } },
        `game.board is not ${POINT_COUNT} points`,
      ],
      [
        'a room whose board is one point too long',
        {
          ...makeRoom(),
          game: { ...initialState(), board: Array(POINT_COUNT + 1).fill(null) },
        },
        `game.board is not ${POINT_COUNT} points`,
      ],
      [
        'a room whose game is only a board',
        { ...makeRoom(), game: { board: Array(POINT_COUNT).fill(null) } },
        'game.hand is not a pair of whole counts',
      ],
      [
        'a room whose game has no turn',
        { ...makeRoom(), game: { ...initialState(), turn: undefined } },
        'game.turn is not a player',
      ],
      // `['W']` rather than a plain non-player: `'W' == ['W']` is true, so a
      // membership test written with `==` is not membership. This is the row
      // that says `isOneOf` compares strictly — the engine's four string unions
      // are checked by membership against its own tables, and a loose compare
      // would let an array wearing a player's name through onto the read path.
      [
        'a room whose turn is an array wearing a player’s name',
        { ...makeRoom(), game: { ...initialState(), turn: ['W'] } },
        'game.turn is not a player',
      ],
      [
        'a room whose game has no phase',
        { ...makeRoom(), game: { ...initialState(), phase: undefined } },
        'game.phase is not a phase',
      ],
      [
        'a room whose game has no result field',
        { ...makeRoom(), game: { ...initialState(), result: undefined } },
        'game.result is neither a result nor null',
      ],
      // Not `undefined`: that is refused by `result === undefined` as readily
      // as by `isObject`, so the row above cannot see the guard weakened to it
      // — and it was the only fixture that reached the guard at all. A number
      // gets past the mutant and is then blamed on the wrong field entirely.
      [
        'a room whose result is a number',
        { ...makeRoom(), game: { ...initialState(), result: 7 } },
        'game.result is neither a result nor null',
      ],
      [
        'a room whose board holds something that is not a piece',
        {
          ...makeRoom(),
          game: { ...initialState(), board: Array(POINT_COUNT).fill(42) },
        },
        'game.board holds something that is not a piece',
      ],
      [
        'a room whose board holds strings that are not pieces',
        {
          ...makeRoom(),
          game: { ...initialState(), board: Array(POINT_COUNT).fill('rook') },
        },
        'game.board holds something that is not a piece',
      ],
      // `'W'`, not `'.'`: the cell test refuses a `'.'` with the same error
      // class, so with a dot this row passed whether or not `Array.isArray` was
      // there. Every character of this one is a legal cell, so without that
      // conjunct the string sails through both guards and `get` hands the app a
      // `Room` whose `game.board` is a **string** typed `Cell[]` — copied
      // straight into a 200 body, and with no `.map` for `legalActions` to call.
      [
        'a room whose board is a 24-character string of legal cells',
        {
          ...makeRoom(),
          game: { ...initialState(), board: 'W'.repeat(POINT_COUNT) },
        },
        `game.board is not ${POINT_COUNT} points`,
      ],
      [
        'a room whose rematch flags are not booleans',
        { ...makeRoom(), rematch: { W: 'yes', B: false } },
        'rematch is not a pair of flags',
      ],
    ];

    it.each(cases)(
      'refuses to hand the app %s',
      async (_name, value, detail) => {
        const error = await new RedisStore(stored(value))
          .get('ABCD2345')
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(CorruptRoomError);
        expect((error as Error).message).toBe(
          `Room ABCD2345 is not readable: ${detail}`,
        );
      },
    );

    it('does not turn a versionless room into a 409 with actualVersion undefined', async () => {
      // The blind cast used to make this a VersionConflictError whose
      // `actualVersion` was `undefined` against a field declared `number` —
      // straight into a 409 body.
      const error = await new RedisStore(stored(noVersion))
        .update('ABCD2345', (r) => r, 1)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      // The reason, not the absence of a class. `not.toBeInstanceOf(
      // VersionConflictError)` could not fail once the line above passed; this
      // says the refusal was about the missing version and nothing else.
      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: version is not a whole count',
      );
      expect(error).toMatchObject({ roomId: 'ABCD2345' });
    });

    it('names the room and quotes what the parser said', async () => {
      // Whole message, with the parser's own words computed rather than
      // transcribed — they are V8's, not this store's, and they change between
      // Node versions. `toContain('not JSON')` passed just as well with the
      // reason dropped from the sentence entirely, which leaves an operator
      // holding "not JSON" and no idea where in the bytes it went wrong.
      let raised = '';
      try {
        JSON.parse('{not json');
      } catch (e) {
        raised = (e as Error).message;
      }
      expect(raised).not.toBe('');

      const error = await new RedisStore(stored('{not json'))
        .get('ABCD2345')
        .catch((e: unknown) => e);

      expect((error as Error).message).toBe(
        `Room ABCD2345 is not readable: value is not JSON (${raised})`,
      );
    });

    it('says the value is not an object, not that its version is missing', async () => {
      // Pins the `!Array.isArray` guard in the object test: without it an array
      // falls through to the version check and reports the wrong reason, and
      // `Object.assign([], room)` — which a deserializing client can hand back —
      // would be accepted as a room outright.
      const error = await new RedisStore(stored('[]'))
        .get('ABCD2345')
        .catch((e: unknown) => e);
      expect((error as Error).message).toContain('value is []');

      const client = new FakeRedis();
      client.get = async () => Object.assign([], makeRoom());
      await expect(new RedisStore(client).get('ABCD2345')).rejects.toThrow(
        CorruptRoomError,
      );
    });

    it('refuses a value that has no JSON form at all', async () => {
      // A deserializing client can hand back anything; `JSON.stringify` returns
      // `undefined` for a function, so the reason string needs a fallback.
      const client = new FakeRedis();
      client.get = async () => () => 'not a room';
      const error = await new RedisStore(client)
        .get('ABCD2345')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      // Exact, for the same reason as the write-path twin: the `what` label is
      // the only thing separating "the room the caller handed us" from "the
      // value we read back", and a `toContain` on the room id pins neither.
      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: the stored value has no JSON form',
      );
    });

    it.each<[string, unknown, (value: unknown) => string]>([
      [
        'a bigint, which JSON.stringify throws on',
        BigInt(1),
        (value) => {
          // V8's words, computed rather than transcribed, so the pin survives a
          // Node upgrade — the same rule the write-path twin follows.
          let raised = '';
          try {
            JSON.stringify(value);
          } catch (e) {
            raised = (e as Error).message;
          }
          expect(raised).not.toBe('');
          return `the stored value cannot be serialised (${raised})`;
        },
      ],
      [
        'a symbol, which it returns undefined for',
        Symbol('nope'),
        (value) => {
          expect(JSON.stringify(value)).toBeUndefined();
          return 'the stored value has no JSON form';
        },
      ],
    ])(
      'says which way %s failed to serialise, not just that it failed',
      async (_n, value, expected) => {
        // Was `describes %s without throwing from the error path`, over these two
        // and `undefined`, asserting nothing but `toBeInstanceOf(
        // CorruptRoomError)`. Three things were wrong with it. It named
        // `describeValue`'s catch arm and never called `describeValue`: these are
        // `stringifyOrThrow`'s two arms, the throw and the `undefined` return.
        // The `undefined` row was not this branch at all — it is the missing-key
        // read, already pinned by "reads a missing key back as null" below. And
        // the type assertion cannot tell "reported the value" from "dropped it",
        // which is the whole point of a helper that exists so the error path can
        // still say what arrived. The message, whole, is the only thing that can.
        const client = new FakeRedis();
        client.get = async () => value;
        const error = await new RedisStore(client)
          .get('ABCD2345')
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(CorruptRoomError);
        expect((error as Error).message).toBe(
          `Room ABCD2345 is not readable: ${expected(value)}`,
        );
      },
    );

    it('refuses a stored room that announces a different id', async () => {
      // The case CorruptRoomError's own doc names — something else wrote the
      // key. The write path spends two refusals on this invariant; the read path
      // used to hand the room over verbatim, and `publicRoom` copied it straight
      // into a 200 body.
      const error = await new RedisStore(stored(makeRoom({ id: 'HIJACKED' })))
        .get('ABCD2345')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toBe(
        'Room ABCD2345 is not readable: room announces id "HIJACKED"',
      );
    });

    it.each([
      [
        'a game that is null',
        { ...makeRoom(), game: null },
        'Room ABCD2345 is not readable: game is not a game state',
      ],
      [
        'a game that is a number',
        { ...makeRoom(), game: 7 },
        'Room ABCD2345 is not readable: game is not a game state',
      ],
      [
        'a lastMove that is a number',
        { ...makeRoom(), game: { ...initialState(), lastMove: 5 } },
        'Room ABCD2345 is not readable: game.lastMove is neither a move nor null',
      ],
      [
        'a lastMove that is an array',
        { ...makeRoom(), game: { ...initialState(), lastMove: [0, 1] } },
        'Room ABCD2345 is not readable: game.lastMove is neither a move nor null',
      ],
    ])('rejects %s with the exact reason', async (_name, value, message) => {
      // These live on the *read* path deliberately. The write path routes every
      // validation failure back out through `guardingReads`, which produces a
      // `CorruptRoomError` whatever the cause, so `rejects.toThrow(CorruptRoomError)`
      // there cannot tell a missing guard from a present one — a `game` of
      // `null` reaching `null.board` throws a `TypeError` that comes back
      // looking identical.
      const error = await new RedisStore(stored(value))
        .get('ABCD2345')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toBe(message);
    });

    it('sizes the board against the engine, not against a copy of 24', async () => {
      // The message interpolates `POINT_COUNT`, and the claim on that import is
      // that it is imported, *not* copied. No room can tell the template from
      // the literal string "game.board is not 24 points" while the engine says
      // 24 — the only input that distinguishes them is a different engine, so
      // that is the input. Mutating the constant in place would be a mirror by
      // another name; this asserts the gate follows whatever the engine says.
      vi.resetModules();
      const engine = await import('@/lib/engine');
      vi.doMock('@/lib/engine', () => ({ ...engine, POINT_COUNT: 25 }));
      try {
        const { roomFromJson } = await import('./types');
        expect(() => roomFromJson(JSON.stringify(makeRoom()), 'ABCD2345')).toThrow(
          'Room ABCD2345 is not readable: game.board is not 25 points',
        );
      } finally {
        vi.doUnmock('@/lib/engine');
        vi.resetModules();
      }
    });

    it('still reads a well-formed room', async () => {
      const room = makeRoom();
      expect(await new RedisStore(stored(room)).get('ABCD2345')).toEqual(room);
    });
  });

  /**
   * Nothing in this repo can execute Lua, so the script is the one part of the
   * store with no test behind its behaviour — `FakeRedis` re-implements its
   * semantics in JavaScript, which proves the store talks to it correctly and
   * proves nothing about the script itself. Substring assertions were worse than
   * they looked: they passed unchanged if the two failure returns were swapped,
   * if `tonumber` were dropped, or if the `cjson.decode` went away.
   *
   * So: pin the whole text. This test cannot tell you the Lua is right, but it
   * guarantees no edit to it is silent — changing the script means changing this
   * literal, deliberately, and re-deriving what the new one does.
   */
  it('is exactly the compare-and-set that was reviewed', () => {
    expect(UPDATE_SCRIPT).toBe(
      [
        "local current = redis.call('GET', KEYS[1])",
        'if not current then return {-1, -1} end',
        'local ok, room = pcall(cjson.decode, current)',
        "if not ok or type(room) ~= 'table' or type(room.version) ~= 'number' then return {-2, -2} end",
        'local expected = tonumber(ARGV[2])',
        'if room.version ~= expected then return {0, room.version} end',
        "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])",
        'return {1, expected + 1}',
      ].join('\n'),
    );
  });

  it('parses each status the script can return', async () => {
    // Replaces three `toContain` assertions on the same string the full-text pin
    // above already fixes character for character — they could not fail unless
    // that test had failed first. These drive the store's three branches instead.
    const room = makeRoom({ version: 1 });

    const written = new FakeRedis();
    const store = new RedisStore(written);
    await store.set(room.id, room);
    expect((await store.update(room.id, (r) => r, 1)).version).toBe(2);

    const stale = new FakeRedis();
    await new RedisStore(stale).set(room.id, room);
    stale.eval = async () => [0, 7];
    await expect(
      new RedisStore(stale).update(room.id, (r) => r, 1),
    ).rejects.toThrow(VersionConflictError);

    const missing = new FakeRedis();
    await new RedisStore(missing).set(room.id, room);
    missing.eval = async () => [-1, -1];
    await expect(
      new RedisStore(missing).update(room.id, (r) => r, 1),
    ).rejects.toThrow(RoomNotFoundError);

    // -2 and -1 are distinct answers, not two spellings of "gone": the first is
    // a 500 and the second a 404, so dropping the -2 arm mislabels a corrupt key
    // as a room that expired.
    const corrupt = new FakeRedis();
    await new RedisStore(corrupt).set(room.id, room);
    corrupt.eval = async () => [-2, -2];
    await expect(
      new RedisStore(corrupt).update(room.id, (r) => r, 1),
    ).rejects.toThrow(CorruptRoomError);
  });

  it.each<[unknown[], string]>([
    [[7, 7], '7'],
    [[-3, -3], '-3'],
    [[2, 9], '2'],
  ])(
    'refuses the unrecognised script status in %j instead of calling the room gone',
    async (evaluated, status) => {
      // `-1` used to have no named constant, so the trailing `throw new
      // RoomNotFoundError(id)` served as both the key-missing arm and the
      // fall-through for every other status. A status the script does not
      // currently produce therefore came back as a 404 — the client discards a
      // live game — while the room was still sitting under the key, which is what
      // the last assertion here is for. `UPDATE_SCRIPT` cannot produce one today,
      // but the `RedisClient` seam is public and "not producible today" has been
      // the wrong reason to drop a guard three times in this directory.
      const client = new FakeRedis();
      const store = new RedisStore(client);
      const room = makeRoom({ version: 1 });
      await store.set(room.id, room);
      client.eval = async () => evaluated;

      const error = await store
        .update(room.id, (r) => r, 1)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CorruptRoomError);
      expect((error as Error).message).toBe(
        `Room ABCD2345 is not readable: the room update script returned status ${status}`,
      );
      expect(error).toMatchObject({ roomId: 'ABCD2345' });
      // Still there. That is the whole complaint: a 404 says it is not.
      expect((await store.get(room.id))?.version).toBe(1);
    },
  );

  it('still reports the key-missing status as a room that is gone', async () => {
    // The other side of the fix: `-1` keeps its own arm, and it is a 404. Without
    // the named constant this was indistinguishable from the fall-through.
    const client = new FakeRedis();
    const store = new RedisStore(client);
    const room = makeRoom({ version: 1 });
    await store.set(room.id, room);
    client.eval = async () => [-1, -1];

    const error = await store
      .update(room.id, (r) => r, 1)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RoomNotFoundError);
    expect((error as Error).message).toBe('Room ABCD2345 not found');
  });

  it.each<[string, unknown, string]>([
    ['a one-element result, which a nil room.version used to produce', [0], '[0]'],
    [
      'a three-element result, which means the script changed',
      [1, 2, 3],
      '[1,2,3]',
    ],
    ['a result that is not an array', 'nope', '"nope"'],
    // The `Array.isArray` conjunct's own counter-example: an array-like object
    // clears every other conjunct — `length` is 2 and both indices are numbers —
    // so without it this is read as a successful write. The real client cannot
    // produce one (the script returns a Lua array and `update` calls `eval` with
    // no other script), but the seam is injectable and the conjunct is load-
    // bearing for anything that reaches it.
    [
      'an array-like object that is not an array',
      JSON.parse('{"0":1,"1":2,"length":2}') as unknown,
      '{"0":1,"1":2,"length":2}',
    ],
    ['a result whose status is not a number', ['1', 2], '["1",2]'],
    ['a result whose version is not a number', [1, '2'], '[1,"2"]'],
    // The seam is injectable, so the error path has to survive values
    // `JSON.stringify` cannot render: it throws on a bigint and returns the
    // *value* `undefined` for a function.
    ['a result that is a bigint', BigInt(7), 'a bigint with no JSON form'],
    ['a result that is a function', () => 1, '() => 1'],
  ])('refuses %s', async (_name, evaluated, rendered) => {
    // `return {0, room.version}` is a *one*-element Lua table when room.version
    // is nil, because a table's array part ends at its first nil — that is what
    // a versionless value written between the read and the EVAL used to yield,
    // before the script answered that case as `-2`. The guard that catches it is
    // `typeof raw[1] === 'number'`, not the length check; the length check earns
    // its place on the other side, stopping a *longer* result from being read as
    // its first two elements after a change to the script. Both elements are
    // type-checked, so both are pinned here.
    //
    // The message is asserted whole. `/update script/` alone let the value that
    // actually came back be dropped from it, which is the only part an operator
    // reading the log has to work with.
    const client = new FakeRedis();
    const store = new RedisStore(client);
    const room = makeRoom();
    await store.set(room.id, room);
    client.eval = async () => evaluated;

    const error = await store
      .update(room.id, (r) => r, room.version)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CorruptRoomError);
    expect((error as Error).message).toBe(
      `Room ABCD2345 is not readable: the room update script returned ${rendered}`,
    );
    expect(error).toMatchObject({ roomId: 'ABCD2345' });
  });

  it.each<[string, unknown]>([
    ['an empty string, as a plain SET would leave it', ''],
    ['a zero from a deserializing client', 0],
    ['a false from a deserializing client', false],
  ])('does not mistake %s for a missing room', async (_name, value) => {
    // `raw === null || raw === undefined` weakened to `!raw` turns each of these
    // into "the room does not exist" — a 404 through the API — where the truth
    // is a corrupt key and a 500.
    const client = new FakeRedis();
    client.get = async () => value;

    await expect(new RedisStore(client).get('ABCD2345')).rejects.toThrow(
      CorruptRoomError,
    );
  });

  it('reads a missing key back as null whether it comes as null or undefined', async () => {
    const client = new FakeRedis();
    client.get = async () => undefined;
    expect(await new RedisStore(client).get('ABCD2345')).toBeNull();

    client.get = async () => null;
    expect(await new RedisStore(client).get('ABCD2345')).toBeNull();
  });
});
