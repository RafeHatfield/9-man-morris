/**
 * The request-handling layer every route shares (`handlers.ts`): the store seam,
 * the body reader, the shape of a response, and the optimistic-concurrency
 * contract of GDD §7.2 — the 409, the retry budget, and the re-read after a
 * lost write.
 */

import { describe, expect, it, vi } from 'vitest';

import { CorruptRoomError, RoomNotFoundError } from '@/lib/store';

import { MAX_WRITE_ATTEMPTS, setApiStore } from './handlers';
import { REFUSAL } from './refusals';
import {
  act,
  brokenRequest,
  createdGame,
  ctx,
  errorOf,
  getGame,
  getRequest,
  installHarness,
  place,
  play,
  postAction,
  postDraw,
  postGame,
  postJoin,
  rawRequest,
  read,
  refusal,
  request,
  seatedGame,
  stored,
  theStore,
} from './test-harness';
import {
  BrokenStore,
  RaceLostStore,
  RacingStore,
  vanishes,
} from './test-stores';
import type { JoinResponse } from './types';

installHarness();

describe('reading a body', () => {
  it('names the field it went wrong in, and joins several', async () => {
    const game = await seatedGame();

    const one = await postDraw(request({}), ctx(game.id));
    expect(await errorOf(one)).toMatch(/^token: .+/);

    // Two bad fields are reported together, in one sentence, in order.
    const two = await postAction(request({ action: place(0) }), ctx(game.id));
    expect(await errorOf(two)).toMatch(/^token: .+; expectedVersion: .+/);

    // A nested field is named by its whole path: the client is told which field
    // of which object, not just the leaf and not just the top level.
    const nested = await postAction(
      request({
        token: game.W,
        action: { type: 'move', from: 0 },
        expectedVersion: game.version,
      }),
      ctx(game.id),
    );
    expect(await errorOf(nested)).toBe(
      'action.to: Invalid input: expected number, received undefined',
    );

    // A complaint about the body as a whole has no field to name, and must not
    // arrive with an empty label in front of it.
    const whole = await errorOf(await postDraw(rawRequest('[]'), ctx(game.id)));
    expect(whole).toMatch(/^[^:]+/);
  });

  it('reads an empty or whitespace-only body as `{}`', async () => {
    const created = await createdGame();
    // Some clients send a newline, or nothing at all, where they mean `{}`.
    const blank = await postJoin(rawRequest('  \n '), ctx(created.roomId));
    expect((await read<JoinResponse>(blank)).colour).toBe('B');
    expect((await postGame(request())).status).toBe(200);

    // It is still an empty body where the endpoint needs a token in it.
    const draw = await postDraw(rawRequest(' '), ctx(created.roomId));
    expect(draw.status).toBe(400);
    await read(draw);
  });
});

describe('the shape of a response', () => {
  it('carries the room when the server had one, and not when it did not', async () => {
    const game = await seatedGame();
    await play(game, game.W, place(0));

    // Judged against a room: the engine's 400 resyncs the client like any other.
    const illegal = await act(game, game.B, place(0));
    expect(illegal.status).toBe(400);
    expect((await refusal(illegal)).room?.version).toBe(game.version);

    // Judged before a room was read: nothing to resync from, and nothing to say.
    for (const response of [
      await postAction(brokenRequest(), ctx(game.id)),
      await postDraw(request({}), ctx(game.id)),
      // And a room that does not exist has none either.
      await getGame(getRequest(), ctx('ZZZZZZZZ')),
    ]) {
      const body = await refusal(response);
      expect(body.room).toBeUndefined();
      expect(body.error.length).toBeGreaterThan(0);
    }
  });

  it('sets no-store on every response these handlers make', async () => {
    // The polling `GET` (§7.3, every 1.5 s) must never be answered from a cache,
    // and `dynamic = 'force-dynamic'` governs Next's caches, not HTTP ones.
    const game = await seatedGame();
    for (const response of [
      await postGame(request({})),
      await getGame(getRequest(), ctx(game.id)),
      await getGame(getRequest(), ctx('ZZZZZZZZ')),
      await act(game, game.W, place(0)),
      await postDraw(request({}), ctx(game.id)),
    ]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      await read(response);
    }
  });

  it('answers a store failure it does not know with a 500 it authored', async () => {
    const game = await seatedGame();
    // A room with a seat still free, so `/join` reaches its write.
    const open = await createdGame();
    const secret = 'board is not an array';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cases: [string, 'get' | 'set' | 'update', () => Promise<Response>][] = [
      ['GET', 'get', () => getGame(getRequest(), ctx(game.id))],
      ['create', 'set', () => postGame(request({}))],
      // `/join` runs its own write loop, so its rethrow has its own path out.
      ['join', 'update', () => postJoin(request({}), ctx(open.roomId))],
      ['action', 'update', () => act(game, game.W, place(0))],
    ];

    for (const [name, failing, call] of cases) {
      setApiStore(
        new BrokenStore(theStore(), failing, new CorruptRoomError(game.id, secret)),
      );
      const response = await call();
      const body = await refusal(response);

      // A framework 500 would carry no `error` field and no cache header.
      expect({ name, status: response.status }).toEqual({ name, status: 500 });
      expect(body).toEqual({ error: REFUSAL.serverError });
      expect(response.headers.get('cache-control')).toBe('no-store');
      // Nothing the store said about its internals is on the wire.
      expect(JSON.stringify(body)).not.toContain(secret);
      setApiStore(theStore());
    }

    // A store that throws something that is not an `Error` is handled too.
    setApiStore(new BrokenStore(theStore(), 'get', 'not an Error'));
    const odd = await getGame(getRequest(), ctx(game.id));
    expect(odd.status).toBe(500);
    expect(await read(odd)).toEqual({ error: REFUSAL.serverError });

    // The wire says nothing; the log is where an operator on a serverless host
    // learns what broke, and it names the error.
    expect(logged).toHaveBeenCalledTimes(cases.length + 1);
    expect(String(logged.mock.calls[0][1])).toContain('CorruptRoomError');
  });
});

describe('optimistic concurrency', () => {
  it('re-reads the room it hands back after a lost write, on both paths', async () => {
    // The room the caller read is stale by definition here — that is why the
    // write lost. Handing it back would tell the client to re-send pinned to a
    // version the server has already moved past, and it would conflict again.
    const versionless = await seatedGame();
    setApiStore(new RacingStore(theStore(), 3));
    const drew = await postDraw(
      request({ token: versionless.W }),
      ctx(versionless.id),
    );
    expect(drew.status).toBe(409);
    expect((await refusal(drew)).room?.version).toBe(
      (await stored(versionless.id)).version,
    );
    setApiStore(theStore());

    const pinned = await seatedGame();
    setApiStore(new RacingStore(theStore(), 1));
    const acted = await act(pinned, pinned.W, place(0));
    expect(acted.status).toBe(409);
    expect((await refusal(acted)).room?.version).toBe(
      (await stored(pinned.id)).version,
    );
  });

  it('gives an endpoint that pins no version exactly three attempts', async () => {
    const game = await seatedGame();
    const losing = new RaceLostStore(theStore(), 99, (room) => room);
    setApiStore(losing);

    // Two players can tap at the same instant; neither should see a conflict it
    // did not ask for. The budget is bounded on both sides, so neither a
    // shorter one nor an unbounded one passes.
    const response = await postDraw(request({ token: game.W }), ctx(game.id));
    expect(response.status).toBe(409);
    // The store's sentence names the version the caller pinned, which means
    // nothing to an endpoint that pinned none, so those get our own wording.
    expect(await errorOf(response)).toBe(REFUSAL.roomBusy);
    expect(losing.attempts).toBe(MAX_WRITE_ATTEMPTS);
    expect(MAX_WRITE_ATTEMPTS).toBe(3);
  });

  it('does not retry a write the client pinned a version for', async () => {
    const game = await seatedGame();
    const losing = new RaceLostStore(theStore(), 99, (room) => room);
    setApiStore(losing);

    // A pinned version is the client's claim about a board it has drawn: a
    // conflict is news for it, not something to paper over with retries.
    const response = await act(game, game.W, place(0));
    expect(response.status).toBe(409);
    await read(response);
    expect(losing.attempts).toBe(1);
  });

  it.each([
    ['an endpoint that retries', 3, async (id: string, token: string) =>
      postDraw(request({ token }), ctx(id))],
    ['an endpoint that pins a version', 1, async (id: string, token: string) =>
      postAction(
        request({ token, action: place(0), expectedVersion: 2 }),
        ctx(id),
      )],
  ])(
    '404s rather than 409ing about a room that is gone: %s',
    async (_name, getsBeforeGone, call) => {
      const game = await seatedGame();
      // Every write now loses its race, and the room is gone by the time the
      // conflict would be reported — the one path that could answer 409 with
      // nothing to resync from.
      setApiStore(new RaceLostStore(theStore(), getsBeforeGone, vanishes));

      const response = await call(game.id, game.W);
      const body = await refusal(response);
      expect(response.status).toBe(404);
      expect(body.error).toBe(REFUSAL.roomNotFound);
      expect(body.room).toBeUndefined();
    },
  );

  it('404s when a write finds the room gone, on both paths', async () => {
    const game = await seatedGame();
    setApiStore(new BrokenStore(theStore(), 'update', new RoomNotFoundError(game.id)));
    expect((await act(game, game.W, place(0))).status).toBe(404);

    const created = await createdGame();
    setApiStore(
      new BrokenStore(theStore(), 'update', new RoomNotFoundError(created.roomId)),
    );
    const join = await postJoin(request({}), ctx(created.roomId));
    expect(join.status).toBe(404);
    expect(await errorOf(join)).toBe(REFUSAL.roomNotFound);
  });
});
