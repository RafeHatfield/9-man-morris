/**
 * `POST /api/game/[id]/action` (GDD §7.3): the only way a move reaches the game.
 * The engine decides legality, the route decides who may ask and when — and the
 * per-turn clock of §5.3 is restamped here, or deliberately not.
 *
 * The §8.2 refusals this endpoint owes (wrong token, wrong turn, stale version,
 * malformed body) are in `quality-bar.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { REFUSAL } from './refusals';
import {
  act,
  advance,
  ctx,
  errorOf,
  installHarness,
  play,
  place,
  postDraw,
  read,
  refusal,
  remove,
  request,
  resign,
  seatedGame,
  stored,
} from './test-harness';

installHarness();

describe('playing a move', () => {
  it('applies a legal placement, passes the turn, and restarts the clock', async () => {
    const game = await seatedGame(60_000);
    const before = await stored(game.id);
    const room = await play(game, game.W, place(0));

    expect(room.game.board[0]).toBe('W');
    expect(room.game.turn).toBe('B');
    expect(room.game.hand).toEqual({ W: 8, B: 9 });
    expect(room.version).toBe(3);
    // Exactly the second of thinking time `act` spends, not a moment of it
    // carried over (GDD §5.3).
    expect(room.turnStartedAt).toBe(before.turnStartedAt + 1_000);
    expect(room.turnStartedAt).toBe(room.serverNow);

    // And again when Black moves: the restamp is about the turn passing, not
    // about who passed it. Watched on White's move alone, a version that never
    // restamped after Black's would hand White a clock that started when Black
    // began thinking.
    const black = await play(game, game.B, place(8));
    expect(black.game.turn).toBe('W');
    expect(black.turnStartedAt).toBe(room.turnStartedAt + 1_000);
    expect(black.turnStartedAt).toBe(black.serverNow);
  });

  it('keeps the clock running through the removal a mill earns', async () => {
    const game = await seatedGame(60_000);
    await play(game, game.W, place(0));
    await play(game, game.B, place(8));
    await play(game, game.W, place(1));
    await play(game, game.B, place(10));

    // White is on the clock, thinking, and then mills.
    advance(30_000);
    const before = await stored(game.id);
    const milled = await play(game, game.W, place(2));

    expect(milled.game.pendingRemoval).toBe(true);
    expect(milled.game.turn).toBe('W');
    // Removal is a sub-step of the same turn (GDD §4.5), so the clock it is
    // played on is the same clock.
    expect(milled.turnStartedAt).toBe(before.turnStartedAt);

    const removed = await play(game, game.W, remove(8));
    expect(removed.game.turn).toBe('B');
    expect(removed.turnStartedAt).toBeGreaterThan(milled.turnStartedAt);
  });

  it('400s an action the engine refuses, in the engine\'s own words', async () => {
    const game = await seatedGame();
    await play(game, game.W, place(0));

    const response = await act(game, game.B, place(0));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain('occupied');
    // The refusal carries the room, so the client can resync from it.
    expect((await refusal(response)).room?.version).toBe(game.version);
  });

  it('lapses a standing draw offer when the game moves on', async () => {
    const game = await seatedGame();
    // `/draw` has no turn check, so both players can have offered.
    await read(await postDraw(request({ token: game.B }), ctx(game.id)));
    game.version = (await stored(game.id)).version;

    const played = await play(game, game.W, place(0));
    // Both halves: an offer is about the position it was made in (GDD §4.6).
    expect(played.drawOffer).toEqual({ W: false, B: false });
    expect((await stored(game.id)).drawOffer).toEqual({ W: false, B: false });
  });
});

describe('a forfeit sent by a client', () => {
  it('403s from either seat, ahead of the turn check', async () => {
    const game = await seatedGame(60_000);
    // A forfeit is the server's to award, after it has checked the clock (GDD
    // §5.3). Letting a client send one here would be a free win.
    const black = await act(game, game.B, { type: 'forfeit', player: 'W' });
    expect(black.status).toBe(403);
    expect(await errorOf(black)).toBe(REFUSAL.forfeitIsServerIssued);
    expect((await stored(game.id)).game.result).toBeNull();

    // The same from White's seat, which is the other half of "whichever seat
    // sent it": Black is on the clock now, so White's forfeit is the one the
    // engine would otherwise grant, and a refusal narrowed to Black would
    // answer it `it is not your turn` instead.
    await play(game, game.W, place(0));
    const white = await act(game, game.W, { type: 'forfeit', player: 'B' });
    expect(white.status).toBe(403);
    expect(await errorOf(white)).toBe(REFUSAL.forfeitIsServerIssued);
    expect((await stored(game.id)).game.result).toBeNull();
  });
});

describe('resignation', () => {
  it('is the one thing a player may do out of turn', async () => {
    const game = await seatedGame(60_000);
    const started = (await stored(game.id)).turnStartedAt;

    // Half a minute into White's turn, Black resigns.
    advance(30_000);
    const room = await play(game, game.B, resign);
    expect(room.game.result).toEqual({ winner: 'W', reason: 'resign' });
    expect(room.clockRunning).toBe(false);
    // An ending is not the start of a turn, so nothing restamps: the stamp
    // still marks when the turn that was interrupted began.
    expect(room.turnStartedAt).toBe(started);
    expect(room.serverNow - room.turnStartedAt).toBe(31_000);
  });

  it('closes the game to everything, from either seat', async () => {
    const game = await seatedGame(60_000);
    await play(game, game.W, resign);

    // White resigned, so the turn is still White's and Black's placement is out
    // of turn as well as too late — but one room state gets one answer, and the
    // finished game is it. Without this the wrong-turn check could sit above
    // the state check unnoticed, because in a game that ends on a mill the
    // loser is *on* the turn.
    for (const [name, response] of [
      ['another resignation', await act(game, game.W, resign)],
      ['a placement out of turn', await act(game, game.B, place(0))],
      [
        'a client forfeit',
        await act(game, game.B, { type: 'forfeit', player: 'W' }),
      ],
      ['a draw offer', await postDraw(request({ token: game.B }), ctx(game.id))],
    ] as const) {
      expect({ name, status: response.status }).toEqual({ name, status: 409 });
      expect(await errorOf(response)).toBe(REFUSAL.gameOver);
    }
    expect((await stored(game.id)).game.result).toEqual({
      winner: 'B',
      reason: 'resign',
    });
  });
});
