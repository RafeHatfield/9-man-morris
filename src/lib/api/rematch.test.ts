/**
 * `POST /api/game/[id]/rematch` (GDD §5.4): offer and accept in one endpoint.
 * The first call marks the caller; the second, from the other seat, resets the
 * room to a fresh game with the colours swapped. Same URL, same tokens.
 */

import { describe, expect, it } from 'vitest';

import { initialState } from '@/lib/engine';

import { REFUSAL } from './refusals';
import {
  act,
  advance,
  ctx,
  errorOf,
  installHarness,
  now,
  place,
  play,
  postClaimTimeout,
  postRematch,
  read,
  request,
  resign,
  seatedGame,
  stored,
  theStore,
} from './test-harness';
import type { Seats } from './test-harness';
import type { PublicRoom } from './types';

installHarness();

const rematch = (game: Seats, token: string): Promise<Response> =>
  postRematch(request({ token }), ctx(game.id));

/** A seated game with a timer, ended by White resigning. */
async function finishedGame(): Promise<Seats> {
  const game = await seatedGame(60_000);
  await play(game, game.W, resign);
  return game;
}

describe('offering a rematch', () => {
  it.each(['W', 'B'] as const)('is idempotent from seat %s', async (seat) => {
    const game = await finishedGame();
    const started = (await stored(game.id)).turnStartedAt;

    advance(30_000);
    const first = await read<PublicRoom>(await rematch(game, game[seat]));
    expect(first.rematch).toEqual({ W: seat === 'W', B: seat === 'B' });
    expect(first.gameNumber).toBe(1);
    // Asking for a rematch is not starting one: only the reset moves the clock.
    expect(first.turnStartedAt).toBe(started);

    // Asking twice is not an acceptance, and burns no version — a client's
    // pinned action must not be invalidated by its own repeat tap.
    advance(5_000);
    const second = await read<PublicRoom>(await rematch(game, game[seat]));
    expect(second.version).toBe(first.version);
    expect(second.rematch).toEqual(first.rematch);
    expect(second.game.result).not.toBeNull();
    // The client draws its countdown from `serverNow - turnStartedAt`, and it
    // adopts this body like any other: the clock in it has to be the real one.
    expect(second.serverNow).toBe(now());
  });

  it('409s while the game is still being played, from either seat', async () => {
    const game = await seatedGame();
    for (const token of [game.W, game.B]) {
      const response = await rematch(game, token);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe(REFUSAL.gameNotOver);
    }
    // And neither tap was recorded, so the live game cannot be restarted by the
    // other player's first tap once it does end.
    expect((await stored(game.id)).rematch).toEqual({ W: false, B: false });
  });
});

describe('the reset', () => {
  it('starts a fresh game with the colours swapped once both agree', async () => {
    const game = await finishedGame();
    await read(await rematch(game, game.B));

    const response = await rematch(game, game.W);
    const room = await read<PublicRoom>(response);
    expect(response.status).toBe(200);
    expect(room.gameNumber).toBe(2);
    expect(room.game).toEqual(initialState());
    expect(room.rematch).toEqual({ W: false, B: false });
    expect(room.drawOffer).toEqual({ W: false, B: false });
    expect(room.seats).toEqual({ W: true, B: true });
    expect(room.clockRunning).toBe(true);

    // The seats really swapped in the store, not just in the view.
    expect((await stored(game.id)).players).toEqual({ W: game.B, B: game.W });

    // White always moves first (GDD §9), and White is now the player who was
    // Black — so the old White's move is out of turn.
    game.version = room.version;
    expect((await act(game, game.W, place(0))).status).toBe(403);
    expect((await play(game, game.B, place(0))).game.board[0]).toBe('W');
  });

  it('swaps them again on the rematch after that', async () => {
    const game = await finishedGame();
    await read(await rematch(game, game.W));
    const second = await read<PublicRoom>(await rematch(game, game.B));
    expect(second.gameNumber).toBe(2);

    // Game 2, with the creator in Black's seat: the joiner's token is White now,
    // and resigns to end it.
    game.version = second.version;
    await play(game, game.B, resign);

    await read(await rematch(game, game.W));
    const third = await read<PublicRoom>(await rematch(game, game.B));
    expect(third.gameNumber).toBe(3);
    // *Every* rematch swaps (GDD §5.4, §7.4), so game 3 puts the creator back
    // in White's seat — not only the first one does.
    expect((await stored(game.id)).players).toEqual({ W: game.W, B: game.B });

    game.version = third.version;
    expect((await act(game, game.B, place(0))).status).toBe(403);
    expect((await play(game, game.W, place(0))).game.board[0]).toBe('W');
  });

  it('starts the new game on a fresh clock, not the old one', async () => {
    // Ended by a forfeit rather than a resignation: the reset is watched after
    // an ending the clock itself produced.
    const game = await seatedGame(60_000);
    advance(60_001);
    const over = await read<PublicRoom>(
      await postClaimTimeout(request({ token: game.B }), ctx(game.id)),
    );
    expect(over.game.result).toEqual({ winner: 'B', reason: 'forfeit' });

    // Two minutes on the result banner before anyone taps Rematch — longer than
    // the whole timer. The new game must not begin already lost on time.
    advance(2 * 60_000);
    await read(await rematch(game, game.W));
    const fresh = await read<PublicRoom>(await rematch(game, game.B));
    expect(fresh.gameNumber).toBe(2);
    expect(fresh.turnStartedAt).toBe(fresh.serverNow);

    // White moves first and White is now the old Black, so the old White is the
    // only one who could claim — and has nothing to claim.
    advance(1_000);
    const claim = await postClaimTimeout(
      request({ token: game.W }),
      ctx(game.id),
    );
    expect(claim.status).toBe(409);
    expect(await errorOf(claim)).toBe(REFUSAL.clockNotExpired);
  });

  it('clears an offer the last game left standing', async () => {
    const game = await finishedGame();
    // No endpoint can leave an offer on a finished game today; the reset says so
    // anyway, and this is what makes that line more than decoration. Both
    // halves, so a reset that kept either one is visible.
    const room = await stored(game.id);
    await theStore().set(game.id, { ...room, drawOffer: { W: true, B: true } });

    await read(await rematch(game, game.W));
    const fresh = await read<PublicRoom>(await rematch(game, game.B));
    expect(fresh.gameNumber).toBe(2);
    expect(fresh.drawOffer).toEqual({ W: false, B: false });
  });

  it('resets exactly once when both players tap at the same instant', async () => {
    const game = await finishedGame();
    const [a, b] = await Promise.all([
      rematch(game, game.W),
      rematch(game, game.B),
    ]);
    // Neither player should see a conflict it did not ask for: the versionless
    // write path retries a lost race (GDD §7.2).
    expect([a.status, b.status]).toEqual([200, 200]);
    await read(a);
    await read(b);

    const room = await stored(game.id);
    expect(room.gameNumber).toBe(2);
    expect(room.players).toEqual({ W: game.B, B: game.W });
    expect(room.rematch).toEqual({ W: false, B: false });
  });
});
