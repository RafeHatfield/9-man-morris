/**
 * `POST /api/game/[id]/join` (GDD §5.1): the first *other* visitor claims Black
 * and gets their own token; anyone after that is read-only. Until that join
 * lands the room is not being played, and every other endpoint says so.
 */

import { describe, expect, it } from 'vitest';

import { setApiStore } from './handlers';
import { REFUSAL } from './refusals';
import {
  act,
  advance,
  createdGame,
  ctx,
  errorOf,
  getGame,
  getRequest,
  installHarness,
  now,
  place,
  postClaimTimeout,
  postDraw,
  postJoin,
  postRematch,
  read,
  refusal,
  request,
  resign,
  seatedGame,
  stored,
  theStore,
} from './test-harness';
import { RaceLostStore, seatTaken, vanishes } from './test-stores';
import type { JoinResponse, PublicRoom } from './types';

installHarness();

describe('claiming the second seat', () => {
  it('gives the second visitor Black and a token of their own', async () => {
    const created = await createdGame(60_000);

    const response = await postJoin(request({}), ctx(created.roomId));
    const joined = await read<JoinResponse>(response);

    expect(response.status).toBe(200);
    expect(joined.colour).toBe('B');
    expect(joined.token).not.toBe(created.token);
    expect(joined.room.seats).toEqual({ W: true, B: true });
    expect(joined.room.version).toBe(2);
    // Both seats and a timer: now the clock is real.
    expect(joined.room.clockRunning).toBe(true);
  });

  it('409s a third visitor: the room is full', async () => {
    const game = await seatedGame();
    // Time between the join that stamped the clock and this one, so the room
    // this refusal carries is stamped now rather than merely looking as if it
    // were: without the gap the two values are equal whatever the code does.
    advance(45_000);
    const response = await postJoin(request({}), ctx(game.id));
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe(REFUSAL.seatsTaken);
    expect((await refusal(response)).room?.seats).toEqual({ W: true, B: true });
  });

  it.each([60_000, null])(
    'starts the clock at the join, not at creation: timer %s',
    async (timerMs) => {
      const created = await createdGame(timerMs);
      // The link sits unopened in a text message for a day. White's timer must
      // not have been running all that time (GDD §5.1: create, share, wait).
      advance(86_400_000);
      const joined = await read<JoinResponse>(
        await postJoin(request({}), ctx(created.roomId)),
      );

      expect(joined.room.turnStartedAt).toBe(now());
      expect(joined.room.turnStartedAt).toBeGreaterThan(
        created.room.turnStartedAt,
      );
      // Nothing is claimable the instant the game becomes playable.
      const claim = await postClaimTimeout(
        request({ token: joined.token }),
        ctx(created.roomId),
      );
      expect(claim.status).toBe(409);
      expect(await errorOf(claim)).toBe(
        timerMs === null ? REFUSAL.noTimer : REFUSAL.clockNotExpired,
      );
    },
  );

  it('says the room is full only when the seat really went', async () => {
    const created = await createdGame();
    // Three reads see a free seat and lose the write; by the fourth, somebody
    // else is sitting in it — the one path that can honestly say "full".
    setApiStore(new RaceLostStore(theStore(), 3, seatTaken));
    const full = await postJoin(request({}), ctx(created.roomId));
    expect(full.status).toBe(409);
    expect(await errorOf(full)).toBe(REFUSAL.seatsTaken);
    expect((await refusal(full)).room?.seats).toEqual({ W: true, B: true });

    // A busy room is not a full one: the seat is still there to be claimed, so
    // the joiner is told to try again rather than turned away.
    const other = await createdGame();
    setApiStore(new RaceLostStore(theStore(), 99, (room) => room));
    const busy = await postJoin(request({}), ctx(other.roomId));
    expect(busy.status).toBe(409);
    expect(await errorOf(busy)).toBe(REFUSAL.joinRaced);

    // And a room that is gone by the time the retries run out is a 404, not a
    // 409 about a seat in a room nobody can fetch.
    const third = await createdGame();
    setApiStore(new RaceLostStore(theStore(), 3, vanishes));
    const gone = await postJoin(request({}), ctx(third.roomId));
    expect(gone.status).toBe(404);
    expect(await errorOf(gone)).toBe(REFUSAL.roomNotFound);
    expect((await refusal(gone)).room).toBeUndefined();
  });

  it('gives the seat to exactly one of two simultaneous joiners', async () => {
    const created = await createdGame();

    const [a, b] = await Promise.all([
      postJoin(request({}), ctx(created.roomId)),
      postJoin(request({}), ctx(created.roomId)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const joined = await read<JoinResponse>(a.status === 200 ? a : b);
    await read(a.status === 200 ? b : a);
    expect((await stored(created.roomId)).players.B).toBe(joined.token);
  });
});

describe('a room with only its creator in it', () => {
  it('is readable, and shuts every endpoint until the second seat is claimed', async () => {
    const created = await createdGame(60_000);
    const game = { id: created.roomId, W: created.token, B: '', version: 1 };

    // A spectator, and the creator's own polling client, can still read it.
    const room = await read<PublicRoom>(
      await getGame(getRequest(), ctx(created.roomId)),
    );
    expect(room.seats).toEqual({ W: true, B: false });
    expect(room.clockRunning).toBe(false);

    // Nothing else is open — a resignation included. GDD §5.1 has play proceed
    // once the link has been opened, and an offer made now would be waiting to
    // be accepted by the first tap of a player who never saw it.
    advance(86_400_000);
    for (const [name, response] of [
      ['/action', await act(game, game.W, place(0))],
      ['/action resign', await act(game, game.W, resign)],
      ['/draw', await postDraw(request({ token: game.W }), ctx(game.id))],
      ['/rematch', await postRematch(request({ token: game.W }), ctx(game.id))],
      [
        '/claim-timeout',
        await postClaimTimeout(request({ token: game.W }), ctx(game.id)),
      ],
    ] as const) {
      expect({ name, status: response.status }).toEqual({ name, status: 409 });
      expect(await errorOf(response)).toBe(REFUSAL.waitingForOpponent);
    }

    // And the room is exactly as it was created: nothing was recorded on the
    // way to those refusals.
    const untouched = await stored(created.roomId);
    expect(untouched.version).toBe(1);
    expect(untouched.game.result).toBeNull();
    expect(untouched.drawOffer).toEqual({ W: false, B: false });
    expect(untouched.rematch).toEqual({ W: false, B: false });

    // The join is the one request such a room accepts, and once it lands the
    // room plays.
    const joined = await read<JoinResponse>(
      await postJoin(request({}), ctx(created.roomId)),
    );
    game.version = joined.room.version;
    const opened = await act(game, game.W, place(0));
    expect(opened.status).toBe(200);
    await read(opened);
  });
});
