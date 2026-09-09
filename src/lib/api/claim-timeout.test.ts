/**
 * `POST /api/game/[id]/claim-timeout` (GDD §5.3): the opponent claims the win
 * when the player on the clock has run out of time. There is no auto-forfeit —
 * nothing runs between requests on a serverless host — so the clock is only ever
 * judged here, against the server's own time.
 *
 * The boundary the claim turns on (refused at the limit, granted a millisecond
 * later) is in `quality-bar.test.ts`, with the rest of the §8.2 floor.
 */

import { describe, expect, it } from 'vitest';

import { apply } from '@/lib/engine';

import { REFUSAL } from './refusals';
import {
  act,
  advance,
  createdGame,
  ctx,
  errorOf,
  installHarness,
  place,
  play,
  postClaimTimeout,
  postDraw,
  read,
  refusal,
  request,
  resign,
  seatedGame,
  stored,
} from './test-harness';
import type { Seats } from './test-harness';
import type { PublicRoom } from './types';

installHarness();

const claim = (game: Seats, token: string): Promise<Response> =>
  postClaimTimeout(request({ token }), ctx(game.id));

describe('awarding the forfeit', () => {
  it.each([
    ['White runs out and Black claims', 0, 'B'],
    // Both the forfeited player and the claimant could be constants that happen
    // to be right in one arrangement, so the mirror is played too: White plays
    // first, which puts Black on the clock.
    ['Black runs out and White claims', 1, 'W'],
  ] as const)('%s', async (_name, movesFirst, claimant) => {
    const game = await seatedGame(60_000);
    if (movesFirst === 1) await play(game, game.W, place(0));

    advance(60_001);
    const response = await claim(game, game[claimant]);
    const room = await read<PublicRoom>(response);

    expect(response.status).toBe(200);
    expect(room.game.result).toEqual({ winner: claimant, reason: 'forfeit' });
    expect(room.clockRunning).toBe(false);
  });

  it('ends the game with the engine, mid-removal and all', async () => {
    const game = await seatedGame(60_000);
    // White forms a mill and walks away with the removal still owed.
    await play(game, game.W, place(0));
    await play(game, game.B, place(8));
    await play(game, game.W, place(1));
    await play(game, game.B, place(10));
    expect((await play(game, game.W, place(2))).game.pendingRemoval).toBe(true);

    const before = await stored(game.id);
    advance(60_001);
    const room = await read<PublicRoom>(await claim(game, game.B));

    // Every field, not just `result`: a hand-rolled ending would leave
    // `pendingRemoval` set and the client would draw removal mode under a
    // game-over banner. GDD §7.3 — all mutation goes through the engine.
    expect(room.game).toEqual(
      apply(before.game, { type: 'forfeit', player: 'W' }, 'B'),
    );
    expect(room.game.pendingRemoval).toBe(false);
    expect(room.game.board).toEqual(before.game.board);
  });

  it.each(['W', 'B'] as const)(
    'clears a standing draw offer from %s as it ends the game',
    async (offerer) => {
      // `/draw` has no turn check, so the player *on* the clock can offer a draw
      // and then let it run out. A reset that cleared only the claimant's half
      // would hand back a finished room still saying "White has offered a draw".
      const game = await seatedGame(60_000);
      const offered = await read<PublicRoom>(
        await postDraw(request({ token: game[offerer] }), ctx(game.id)),
      );
      expect(offered.drawOffer).toEqual({
        W: offerer === 'W',
        B: offerer === 'B',
      });

      advance(60_001);
      const room = await read<PublicRoom>(await claim(game, game.B));
      expect(room.game.result).toEqual({ winner: 'B', reason: 'forfeit' });
      expect(room.drawOffer).toEqual({ W: false, B: false });
      expect((await stored(game.id)).drawOffer).toEqual({ W: false, B: false });
      // `turnStartedAt` still marks when the forfeited turn began: an ending is
      // not the start of a turn, so nothing about it moves the clock.
      expect(room.turnStartedAt).toBe(offered.turnStartedAt);
    },
  );

  it('lets exactly one of a racing claim and move land, in either order', async () => {
    for (let round = 0; round < 8; round++) {
      const game = await seatedGame(60_000);
      advance(60_001);

      const claiming = (): Promise<Response> => claim(game, game.B);
      const moving = (): Promise<Response> =>
        act(game, game.W, place(0), game.version);

      const [first, second] =
        round % 2 === 0
          ? await Promise.all([claiming(), moving()])
          : await Promise.all([moving(), claiming()]);
      const [claimed, moved] =
        round % 2 === 0 ? [first, second] : [second, first];

      expect([claimed.status, moved.status].filter((s) => s === 200)).toHaveLength(1);
      // The loser's refusal is about the room as it then is — a version
      // conflict, or `yourOwnClock` when the move restamped the clock onto the
      // claimant's own seat — and either way it carries the room to resync from.
      const loser = claimed.status === 200 ? moved : claimed;
      expect([403, 409]).toContain(loser.status);
      expect((await refusal(loser)).room?.id).toBe(game.id);
      await read(claimed.status === 200 ? claimed : moved);

      const room = await stored(game.id);
      if (claimed.status === 200) {
        expect(room.game.result).toEqual({ winner: 'B', reason: 'forfeit' });
        expect(room.game.board[0]).toBeNull();
      } else {
        expect(room.game.result).toBeNull();
        expect(room.game.board[0]).toBe('W');
      }
    }
  });

  it('measures the clock from the current turn, not the game', async () => {
    const game = await seatedGame(60_000);
    advance(59_000);
    await play(game, game.W, place(0));

    // White's move restarted the clock, so Black now has a full minute.
    const response = await claim(game, game.W);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe(REFUSAL.clockNotExpired);
  });
});

describe('a room with nothing to claim', () => {
  it('409s a game where "None" was chosen, however long it has been', async () => {
    const game = await seatedGame(null);
    advance(86_400_000);

    const response = await claim(game, game.B);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe(REFUSAL.noTimer);
    expect((await stored(game.id)).game.result).toBeNull();
  });

  it.each([
    [
      'a resignation',
      async (game: Seats) => {
        await play(game, game.W, resign);
      },
    ],
    [
      'an agreed draw',
      async (game: Seats) => {
        await read(await postDraw(request({ token: game.W }), ctx(game.id)));
        await read(await postDraw(request({ token: game.B }), ctx(game.id)));
      },
    ],
  ])('409s a game already ended by %s', async (_name, finish) => {
    const game = await seatedGame(60_000);
    await finish(game);
    const ended = (await stored(game.id)).game.result;

    // Before the clock has run: the finished game is the answer, not `the clock
    // has not expired`, which would be true of the room and useless about it.
    const early = await claim(game, game.B);
    expect(early.status).toBe(409);
    expect(await errorOf(early)).toBe(REFUSAL.gameOver);

    // And after it. A finished-game check that recognised only a resignation
    // would let the clock run out on a drawn game and hand the win to whoever
    // asked first — the half point taken back after both players agreed to it.
    advance(60_001);
    const late = await claim(game, game.B);
    expect(late.status).toBe(409);
    expect(await errorOf(late)).toBe(REFUSAL.gameOver);
    expect((await stored(game.id)).game.result).toEqual(ended);
  });

  it('answers the state before the timer, and the timer before the seat', async () => {
    // Three things can be wrong at once; each answer must be the useful one.
    const over = await seatedGame(null);
    await play(over, over.W, resign);
    expect(await errorOf(await claim(over, over.B))).toBe(REFUSAL.gameOver);

    // White is on the clock and claiming its own, which is also wrong — but a
    // game with no timer has no clock for either player to be on.
    const timerless = await seatedGame(null);
    expect(await errorOf(await claim(timerless, timerless.W))).toBe(
      REFUSAL.noTimer,
    );

    // And the seat guard comes before both: "this game has no turn timer" is
    // the wrong explanation for a room that is not being played at all.
    const lone = await createdGame(null);
    const waiting = await postClaimTimeout(
      request({ token: lone.token }),
      ctx(lone.roomId),
    );
    expect(waiting.status).toBe(409);
    expect(await errorOf(waiting)).toBe(REFUSAL.waitingForOpponent);
  });
});
