/**
 * `POST /api/game` and `GET /api/game/[id]` (GDD §7.3): creating a room, and the
 * public view every client polls — which is also what a read-only visitor sees
 * (§6.4), so it needs no token and may never contain one (§7.4).
 */

import { describe, expect, it } from 'vitest';

import {
  TOKEN_SHAPE,
  advance,
  createdGame,
  ctx,
  getGame,
  getRequest,
  installHarness,
  now,
  play,
  postClaimTimeout,
  postRematch,
  postGame,
  postJoin,
  read,
  request,
  resign,
  seatedGame,
  stored,
} from './test-harness';
import type { Seats } from './test-harness';
import type { CreateGameResponse, JoinResponse, PublicRoom } from './types';

installHarness();

async function view(id: string): Promise<PublicRoom> {
  return read<PublicRoom>(await getGame(getRequest(), ctx(id)));
}

describe('POST /api/game', () => {
  it('creates a room whose creator is White, with seat W taken', async () => {
    const response = await postGame(request({ timerMs: 60_000 }));
    const body = await read<CreateGameResponse>(response);

    expect(response.status).toBe(200);
    expect(body.colour).toBe('W');
    expect(body.roomId).toHaveLength(8);
    expect(body.room).toMatchObject({
      id: body.roomId,
      version: 1,
      timerMs: 60_000,
      seats: { W: true, B: false },
      gameNumber: 1,
    });
    expect(body.room.game.turn).toBe('W');
    expect(body.room.game.phase).toBe('placing');
    // A timer is chosen, but nothing is counting down yet (GDD §5.3).
    expect(body.room.clockRunning).toBe(false);

    const room = await stored(body.roomId);
    expect(room.players).toEqual({ W: body.token, B: null });
    expect(room.createdAt).toBe(now());
  });

  it('issues a distinct 32-hex token per seat, and a distinct id per room', async () => {
    const tokens = new Set<string>();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const created = await createdGame();
      expect(created.token).toMatch(TOKEN_SHAPE);
      tokens.add(created.token);
      // `RoomStore.set` is create-or-replace, so a repeated id would not fail:
      // it would silently overwrite a live game and put two pairs of players on
      // one URL, with the first creator's token still holding seat W.
      ids.add(created.roomId);

      // A token is a bearer credential (§5.1), so a constant on the join side
      // would seat the holder of *any* Black token in *every* room.
      const joined = await read<JoinResponse>(
        await postJoin(request({}), ctx(created.roomId)),
      );
      expect(joined.token).toMatch(TOKEN_SHAPE);
      tokens.add(joined.token);
    }
    expect(tokens.size).toBe(50);
    expect(ids.size).toBe(25);
  });
});

describe('GET /api/game/[id]', () => {
  it('returns the public room to anyone, with no token', async () => {
    const game = await seatedGame();
    const response = await getGame(getRequest(), ctx(game.id));
    const room = await read<PublicRoom>(response);

    expect(response.status).toBe(200);
    expect(room).toMatchObject({ id: game.id, seats: { W: true, B: true } });
  });

  it('withholds the tokens, and says only whether the seats are taken', async () => {
    const game = await seatedGame(60_000);
    const room = await stored(game.id);
    const published = await view(game.id);

    // What the wire adds to what is stored (GDD §7.4 lists the storage shape)...
    expect(
      Object.keys(published).filter((key) => !(key in room)).sort(),
    ).toEqual(['clockRunning', 'seats', 'serverNow']);
    // ...and what it withholds: `players` is the tokens, and this is where they
    // stop being sent. Nothing downstream of here can leak what it never got.
    expect(Object.keys(room).filter((key) => !(key in published)).sort()).toEqual(
      ['createdAt', 'players'],
    );
    const wire = JSON.stringify(published);
    expect(wire).not.toContain(game.W);
    expect(wire).not.toContain(game.B);
  });
});

describe('clockRunning', () => {
  /**
   * The invariant behind the field rather than a list of states: it is true
   * exactly when nothing but elapsed time stands between the player who is not
   * on the clock and a successful forfeit claim (GDD §5.3). The client draws
   * both the countdown and the "Claim win" button from it.
   */
  const situations: [
    name: string,
    build: () => Promise<{ id: string; claimant: string }>,
  ][] = [
    [
      'nobody has joined yet',
      async () => {
        const created = await createdGame(60_000);
        return { id: created.roomId, claimant: created.token };
      },
    ],
    [
      'a seated game with a timer',
      async () => {
        const game = await seatedGame(60_000);
        return { id: game.id, claimant: game.B };
      },
    ],
    [
      'a seated game with no timer',
      async () => {
        const game = await seatedGame(null);
        return { id: game.id, claimant: game.B };
      },
    ],
    [
      'a game already over',
      async () => {
        const game = await seatedGame(60_000);
        await play(game, game.W, resign);
        return { id: game.id, claimant: game.B };
      },
    ],
    [
      'a fresh game after a rematch',
      async () => {
        const game = await seatedGame(60_000);
        await play(game, game.W, resign);
        await rematchBoth(game);
        // The colours swapped, so the token that was White is off the clock.
        return { id: game.id, claimant: game.W };
      },
    ],
  ];

  it.each(situations)(
    'is true exactly when a claim would succeed: %s',
    async (_name, build) => {
      const { id, claimant } = await build();
      advance(2 * 86_400_000);

      // The view is read *after* the clock has run out, not before: that is the
      // moment the field is about. A `clockRunning` that went false the instant
      // the clock expired would hide the button exactly when the win became
      // claimable, and with no auto-forfeit (§5.3) the game would deadlock.
      const room = await view(id);
      const response = await postClaimTimeout(
        request({ token: claimant }),
        ctx(id),
      );
      await read(response);

      expect(response.status === 200).toBe(room.clockRunning);
    },
  );
});

async function rematchBoth(game: Seats): Promise<void> {
  await read(await postRematch(request({ token: game.W }), ctx(game.id)));
  const reset = await read<PublicRoom>(
    await postRematch(request({ token: game.B }), ctx(game.id)),
  );
  game.version = reset.version;
}
