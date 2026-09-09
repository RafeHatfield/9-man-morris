/**
 * `POST /api/game/[id]/draw` (GDD §4.6): offer and accept in one endpoint. The
 * first call is the offer; the same call from the other seat accepts it and the
 * engine ends the game as a draw.
 *
 * Two optional fields say what the tap was made against: `gameNumber`, the game
 * it was about, and `accepting`, the decision the button was offering to make.
 * The game ends "only if the other accepts", and without them an offer landing
 * while a tap is in flight turns that tap into an acceptance of something its
 * player never saw.
 */

import { describe, expect, it } from 'vitest';

import { agreeDraw } from '@/lib/engine';

import { REFUSAL } from './refusals';
import {
  advance,
  createdGame,
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
  request,
  resign,
  seatedGame,
  stored,
} from './test-harness';
import type { Seats } from './test-harness';
import type { PublicRoom } from './types';

installHarness();

function draw(
  game: Seats,
  token: string,
  body: { gameNumber?: number; accepting?: boolean } = {},
): Promise<Response> {
  return postDraw(request({ token, ...body }), ctx(game.id));
}

describe('offering and agreeing', () => {
  it('offers, then agrees when the other player answers', async () => {
    const game = await seatedGame(60_000);

    const offered = await read<PublicRoom>(await draw(game, game.W));
    expect(offered.drawOffer).toEqual({ W: true, B: false });
    // White is on the clock: if offering stamped it, White could hold the game
    // open for ever by offering.
    expect(offered.turnStartedAt).toBe((await stored(game.id)).turnStartedAt);

    // Offering again is not accepting your own offer, and burns no version.
    const again = await read<PublicRoom>(await draw(game, game.W));
    expect(again.version).toBe(offered.version);
    expect(again.game.result).toBeNull();

    advance(30_000);
    const accepted = await read<PublicRoom>(await draw(game, game.B));
    expect(accepted.game.result).toEqual({ winner: null, reason: 'drawagreed' });
    // Agreeing ends the game; it does not start a turn, so the clock stays
    // where the turn left it.
    expect(accepted.turnStartedAt).toBe(offered.turnStartedAt);
    // And nothing is still being offered on a game that has just been agreed.
    expect(accepted.drawOffer).toEqual({ W: false, B: false });
    expect((await stored(game.id)).drawOffer).toEqual({ W: false, B: false });
  });

  it('agrees the draw with the engine, mid-removal and all', async () => {
    const game = await seatedGame();
    await play(game, game.W, place(0));
    await play(game, game.B, place(8));
    await play(game, game.W, place(1));
    await play(game, game.B, place(10));
    expect((await play(game, game.W, place(2))).game.pendingRemoval).toBe(true);

    // Black offers, so `drawOffer.B` is true going in and a half-reset would
    // leave a finished game still offering.
    await read(await draw(game, game.B));
    const before = await stored(game.id);

    const agreed = await read<PublicRoom>(await draw(game, game.W));
    // The whole state, from `agreeDraw` — including the removal the mill owed,
    // which the engine drops when it finishes a game.
    expect(agreed.game).toEqual(agreeDraw(before.game));
    expect(agreed.game.pendingRemoval).toBe(false);
    expect(agreed.drawOffer).toEqual({ W: false, B: false });
  });

  it('409s once the game is over, from either seat', async () => {
    const game = await seatedGame(60_000);
    advance(60_001);
    const over = await read<PublicRoom>(
      await postClaimTimeout(request({ token: game.B }), ctx(game.id)),
    );
    expect(over.game.result).toEqual({ winner: 'B', reason: 'forfeit' });

    // A check that recognised only a resignation would stand an offer on a game
    // already lost on time — and the winner's next plain tap would agree a draw
    // in it, turning a win into half a point.
    for (const token of [game.W, game.B]) {
      const response = await draw(game, token);
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toBe(REFUSAL.gameOver);
    }
    const room = await stored(game.id);
    expect(room.drawOffer).toEqual({ W: false, B: false });
    expect(room.game.result).toEqual({ winner: 'B', reason: 'forfeit' });
  });
});

describe('an offer that has lapsed', () => {
  it.each(['W', 'B'] as const)(
    'is not accepted by the next tap after %s plays on',
    async (offerer) => {
      const game = await seatedGame();
      // `/draw` has no turn check, so the player on the clock can offer and then
      // play on; the offer was about the position before that move.
      const offered = await read<PublicRoom>(await draw(game, game[offerer]));
      expect(offered.drawOffer).toEqual({
        W: offerer === 'W',
        B: offerer === 'B',
      });

      game.version = offered.version;
      expect((await play(game, game.W, place(0))).drawOffer).toEqual({
        W: false,
        B: false,
      });

      // So the other player's next plain tap is an offer of their own. Had the
      // lapsed one survived, this tap would silently agree a draw about a
      // position the offer was never made about (GDD §4.6).
      const other = offerer === 'W' ? game.B : game.W;
      const next = await read<PublicRoom>(await draw(game, other));
      expect(next.game.result).toBeNull();
      expect(next.drawOffer).toEqual({
        W: other === game.W,
        B: other === game.B,
      });
      expect((await stored(game.id)).game.result).toBeNull();
    },
  );

  it('is not accepted on purpose either', async () => {
    const game = await seatedGame();
    await read(await draw(game, game.B));

    // Black offers, then plays on, which lapses the offer. White's page still
    // shows "Accept draw"; that tap must not silently become an offer.
    game.version = (await stored(game.id)).version;
    await play(game, game.W, place(0));
    await play(game, game.B, place(8));

    const stale = await draw(game, game.W, { accepting: true });
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toBe(REFUSAL.differentOffer);
    expect((await stored(game.id)).drawOffer).toEqual({ W: false, B: false });
  });
});

describe('what the tap was made against', () => {
  it.each(['W', 'B'] as const)(
    'does not turn %s\'s offer into an acceptance when one lands mid-request',
    async (offerer) => {
      const game = await seatedGame();
      // The offerer's tap lands before the other player's, whose page still
      // shows "Offer draw" — the race the client cannot close, because both
      // taps carry the same room and the same game number.
      const arrived = await read<PublicRoom>(await draw(game, game[offerer]));
      const other = offerer === 'W' ? game.B : game.W;

      const tap = await draw(game, other, { gameNumber: 1, accepting: false });
      const body = await refusal(tap);
      expect(tap.status).toBe(409);
      expect(body.error).toBe(REFUSAL.differentOffer);
      // Nobody accepted anything, in the view or in the store (GDD §4.6).
      expect(body.room?.game.result).toBeNull();
      expect(body.room?.drawOffer).toEqual(arrived.drawOffer);
      const room = await stored(game.id);
      expect(room.game.result).toBeNull();
      expect(room.drawOffer).toEqual(arrived.drawOffer);

      // Told what is really on the board, the same player can accept on purpose.
      const agreed = await draw(game, other, { gameNumber: 1, accepting: true });
      expect((await read<PublicRoom>(agreed)).game.result).toEqual({
        winner: null,
        reason: 'drawagreed',
      });
    },
  );

  it("refuses an acceptance when the standing offer is the caller's own", async () => {
    const game = await seatedGame();
    const offered = await read<PublicRoom>(await draw(game, game.W));

    // The second-tab case §5.1 supports: that tab still shows "Accept draw" from
    // an offer that has since lapsed, and the only offer standing is this
    // player's own. Answering 200 would report an acceptance that never was.
    const stale = await draw(game, game.W, { accepting: true });
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toBe(REFUSAL.differentOffer);
    expect((await stored(game.id)).game.result).toBeNull();

    // Repeating the offer it did make is still the no-op it always was.
    const again = await read<PublicRoom>(
      await draw(game, game.W, { accepting: false }),
    );
    expect(again.version).toBe(offered.version);
    expect(again.drawOffer).toEqual({ W: true, B: false });
  });

  it('takes a tap that agrees with the board, and one that claims nothing', async () => {
    const game = await seatedGame();

    // "I am offering in game 1, and there is nothing to accept" — all true.
    const offered = await read<PublicRoom>(
      await draw(game, game.W, { gameNumber: 1, accepting: false }),
    );
    expect(offered.drawOffer).toEqual({ W: true, B: false });

    // A body that claims nothing is judged exactly as it was before those
    // fields existed.
    const agreed = await read<PublicRoom>(await draw(game, game.B));
    expect(agreed.game.result).toEqual({ winner: null, reason: 'drawagreed' });
  });

  it('refuses a tap about another game, whether behind or ahead', async () => {
    const game = await seatedGame();

    // Ahead: a client that has somehow got in front of the server is as wrong
    // about the position as one left behind, and the pin is "this game", not
    // "no earlier than this game". `accepting: true` where nothing is offered
    // makes two things wrong at once; which *game* comes first.
    const ahead = await draw(game, game.W, { gameNumber: 99, accepting: true });
    expect(ahead.status).toBe(409);
    expect(await errorOf(ahead)).toBe(REFUSAL.differentGame);
    expect((await stored(game.id)).drawOffer).toEqual({ W: false, B: false });

    // Behind: the room has moved on to game 2 after a rematch, and a background
    // tab's "Offer draw" button has outlived the game it was drawn for (§7.3).
    await play(game, game.W, resign);
    await read(await postRematch(request({ token: game.W }), ctx(game.id)));
    const restarted = await read<PublicRoom>(
      await postRematch(request({ token: game.B }), ctx(game.id)),
    );
    expect(restarted.gameNumber).toBe(2);

    // The colours swapped, so the token that was White now sits in Black's seat
    // and offers a draw in game 2...
    const offered = await read<PublicRoom>(await draw(game, game.W));
    expect(offered.drawOffer).toEqual({ W: false, B: true });

    // ...and the other player's page, frozen on game 1, taps Offer draw. One tap
    // must not agree a draw in a game it has never seen.
    const stale = await draw(game, game.B, { gameNumber: 1 });
    const body = await refusal(stale);
    expect(stale.status).toBe(409);
    expect(body.error).toBe(REFUSAL.differentGame);
    expect(body.room?.gameNumber).toBe(2);
    expect((await stored(game.id)).game.result).toBeNull();

    // Sent about the game it is really looking at, the same tap is an
    // acceptance, as it always was.
    const agreed = await read<PublicRoom>(
      await draw(game, game.B, { gameNumber: 2 }),
    );
    expect(agreed.game.result).toEqual({ winner: null, reason: 'drawagreed' });
  });

  it('is judged after the seats and before the game state', async () => {
    const game = await seatedGame();
    await play(game, game.W, resign);

    // The game is over *and* the tap names a game the room is not on. The
    // staleness answer wins: "the game is over" would be about a game the client
    // was not asking about.
    expect(await errorOf(await draw(game, game.W, { gameNumber: 99 }))).toBe(
      REFUSAL.differentGame,
    );

    // But a room with one seat is not playing any game yet, so that answer comes
    // first: there is nothing to be stale about.
    const lone = await createdGame();
    const waiting = await postDraw(
      request({ token: lone.token, gameNumber: 99 }),
      ctx(lone.roomId),
    );
    expect(waiting.status).toBe(409);
    expect(await errorOf(waiting)).toBe(REFUSAL.waitingForOpponent);
  });
});
