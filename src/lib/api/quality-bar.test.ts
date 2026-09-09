/**
 * The quality bar of GDD §8.2, in one file: *every* endpoint rejects a wrong
 * token, a wrong turn, a stale version and a malformed body with the right
 * status, and the timeout claim is refused before the clock expires and
 * accepted after it.
 *
 * The route-specific behaviour lives in a file per route; this is the floor they
 * all stand on, kept together so it can be read as the checklist it is.
 */

import { describe, expect, it } from 'vitest';

import { REFUSAL } from './refusals';
import {
  STRANGER,
  act,
  advance,
  ctx,
  errorOf,
  installHarness,
  place,
  play,
  postClaimTimeout,
  postDraw,
  postRematch,
  read,
  refusal,
  remove,
  request,
  seatedGame,
  stored,
  theStore,
} from './test-harness';
import type { Seats } from './test-harness';
import type { PublicRoom } from './types';

installHarness();

describe('a wrong token', () => {
  const endpoints: [
    name: string,
    call: (game: Seats, token: string) => Promise<Response>,
  ][] = [
    ['/action', (game, token) => act(game, token, place(0))],
    [
      '/claim-timeout',
      (game, token) => postClaimTimeout(request({ token }), ctx(game.id)),
    ],
    ['/rematch', (game, token) => postRematch(request({ token }), ctx(game.id))],
    ['/draw', (game, token) => postDraw(request({ token }), ctx(game.id))],
  ];

  it.each(endpoints)('403s at %s', async (_name, call) => {
    const game = await seatedGame(60_000);
    const response = await call(game, STRANGER);

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toBe(REFUSAL.notAPlayer);
    // A refusal carries the room the server has, so a client can resync from it.
    expect((await refusal(response)).room?.id).toBe(game.id);
  });

  // A real token is 32 lowercase hex characters, too short to slice
  // interestingly and with no case to flip. So this room's seats are rewritten
  // to a fixed, long, mixed-case token, and every probe below is one a
  // comparison weaker than `===` would let through: a strict prefix, a strict
  // superstring, the same token in another case, and one padded either side.
  const FIXED = 'W7fA3b91-Cd52-4E6f-Bb08-1a2B3c4D5e6F';

  it('403s a token that is only nearly a real one', async () => {
    const game = await seatedGame(60_000);
    const room = await theStore().update(
      game.id,
      (current) => ({ ...current, players: { ...current.players, W: FIXED } }),
      game.version,
    );
    game.W = FIXED;
    game.version = room.version;

    for (const probe of [
      FIXED.slice(0, 16),
      `${FIXED}0`,
      FIXED.toUpperCase(),
      ` ${FIXED}`,
      `${FIXED} `,
    ]) {
      expect(probe).not.toBe(FIXED);
      const response = await act(game, probe, place(0));
      expect({ probe, status: response.status }).toEqual({ probe, status: 403 });
      expect(await errorOf(response)).toBe(REFUSAL.notAPlayer);
    }
    expect((await stored(game.id)).game.board[0]).toBeNull();

    // The real token — the only string equal to itself — still plays, so the
    // refusals above are about the probes and not about a broken fixture.
    expect((await play(game, FIXED, place(0))).game.board[0]).toBe('W');
  });
});

describe('a wrong turn', () => {
  it('403s the seat that is not on the clock, from either side', async () => {
    const game = await seatedGame();

    const black = await act(game, game.B, place(0));
    expect(black.status).toBe(403);
    expect(await errorOf(black)).toBe(REFUSAL.notYourTurn);

    // And the mirror: White acting on Black's turn is the same request from the
    // other side, and any client whose poll is one tick behind sends it.
    await play(game, game.W, place(0));
    const white = await act(game, game.W, place(1));
    expect(white.status).toBe(403);
    expect(await errorOf(white)).toBe(REFUSAL.notYourTurn);
    // Nothing was played: the refusal is a refusal, not a slow accept.
    expect((await stored(game.id)).game.board[1]).toBeNull();
  });

  it('403s a removal taken by the player who did not form the mill', async () => {
    const game = await seatedGame();
    await play(game, game.W, place(0));
    await play(game, game.B, place(8));
    await play(game, game.W, place(1));
    await play(game, game.B, place(10));
    const milled = await play(game, game.W, place(2));
    expect(milled.game.pendingRemoval).toBe(true);

    // Removal is a sub-step of White's turn (GDD §4.5), so Black taking a piece
    // is a wrong-turn action — 403 — not an illegal move.
    const response = await act(game, game.B, remove(0));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toBe(REFUSAL.notYourTurn);
    expect((await stored(game.id)).game.board[0]).toBe('W');
  });

  it("403s a claim by the player whose own clock it is", async () => {
    const game = await seatedGame(60_000);
    advance(60_001);

    // The turn check `/claim-timeout` has: the win goes to the *opponent* of
    // whoever ran out (GDD §5.3).
    const response = await postClaimTimeout(
      request({ token: game.W }),
      ctx(game.id),
    );
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toBe(REFUSAL.yourOwnClock);
    expect((await stored(game.id)).game.result).toBeNull();
  });
});

describe('a stale version', () => {
  it('409s and hands back the room the server really has', async () => {
    const game = await seatedGame();
    const stale = game.version;
    await play(game, game.W, place(0));

    const response = await act(game, game.B, place(1), stale);
    const body = await refusal(response);
    expect(response.status).toBe(409);
    expect(body.error).toContain(`not ${stale}`);
    expect(body.room?.version).toBe(game.version);
    expect(body.room?.game.board[0]).toBe('W');
  });

  it.each([
    // Zero is a legitimate integer to send and a stale one for every room
    // (versions start at 1); it must not be read as "pinned nothing".
    ['zero', 0],
    ['a version from the future', 99],
  ])('409s %s', async (_name, expectedVersion) => {
    const game = await seatedGame();
    const response = await act(game, game.W, place(0), expectedVersion);
    expect(response.status).toBe(409);
    await read(response);
    expect((await stored(game.id)).game.board[0]).toBeNull();
  });

  it('is judged ahead of the turn and the move, and behind the token', async () => {
    const game = await seatedGame();
    const stale = game.version;
    await play(game, game.W, place(0));

    // The dropped-response retry: the same client resends the move it already
    // made. It is now out of turn, and Black's copy of it is illegal as well —
    // but what either needs to hear is "resync" (GDD §7.3), not a verdict on a
    // board it has not seen.
    const resent = await act(game, game.W, place(0), stale);
    expect(resent.status).toBe(409);
    const overtaken = await act(game, game.B, place(0), stale);
    expect(overtaken.status).toBe(409);
    expect(await errorOf(overtaken)).not.toContain('occupied');

    // But a token that holds no seat is told about the token: sending that
    // caller round the resync loop would never fix anything.
    const stranger = await act(game, STRANGER, place(1), stale);
    expect(stranger.status).toBe(403);
    expect(await errorOf(stranger)).toBe(REFUSAL.notAPlayer);
  });
});

describe('the timeout claim', () => {
  it('is refused at the limit and granted a millisecond later', async () => {
    const game = await seatedGame(60_000);

    // The instant of expiry is the undecided case in "rejected before the clock
    // expires and accepted after" (GDD §8.2), and it is one character of the
    // comparison that ends the game.
    advance(60_000);
    const at = await postClaimTimeout(request({ token: game.B }), ctx(game.id));
    expect(at.status).toBe(409);
    expect(await errorOf(at)).toBe(REFUSAL.clockNotExpired);
    expect((await stored(game.id)).game.result).toBeNull();

    advance(1);
    const after = await postClaimTimeout(
      request({ token: game.B }),
      ctx(game.id),
    );
    const room = await read<PublicRoom>(after);
    expect(after.status).toBe(200);
    expect(room.game.result).toEqual({ winner: 'B', reason: 'forfeit' });
  });
});
