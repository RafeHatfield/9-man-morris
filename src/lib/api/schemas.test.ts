/**
 * What the request schemas accept and refuse (`schemas.ts`, GDD §8.6), and the
 * English every refusal this API authors reaches the wire in (`refusals.ts`).
 *
 * The schemas check *shape*, not legality: an action that is structurally one of
 * the engine's five variants gets through and the engine judges it. A body that
 * fails here is a 400 and never reaches the store.
 */

import { describe, expect, it, vi } from 'vitest';

import { REFUSAL } from './refusals';
import {
  ctx,
  errorOf,
  installHarness,
  place,
  postAction,
  postDraw,
  postGame,
  read,
  request,
  seatedGame,
} from './test-harness';
import { DEFAULT_TIMER_MS, TIMER_CHOICES } from './types';
import type { CreateGameResponse, PublicRoom } from './types';

installHarness();

describe('the refusal table', () => {
  it('pins every refusal the API authors to its English', () => {
    // The online client compares a message against these to tell this server's
    // answer from a middlebox's JSON 404, so the wording is a wire contract.
    // `REFUSAL` is the only place these sentences exist: the routes throw them
    // by name and these files assert them by name.
    expect(REFUSAL).toEqual({
      roomNotFound: 'room not found',
      notAPlayer: 'this token does not hold a seat in this room',
      badBody: 'body is not valid JSON',
      waitingForOpponent: 'waiting for an opponent to join',
      gameOver: 'the game is over',
      gameNotOver: 'the game is not over',
      notYourTurn: 'it is not your turn',
      forfeitIsServerIssued: 'a forfeit is claimed through /claim-timeout',
      yourOwnClock: 'the clock is yours; only your opponent claims it',
      clockNotExpired: 'the clock has not expired',
      noTimer: 'this game has no turn timer',
      seatsTaken: 'both seats are taken',
      joinRaced: 'the room changed while joining; try again',
      roomBusy: 'the room changed while writing; try again',
      serverError: 'the server could not complete that request',
      timerNotOffered: 'timerMs must be one of the offered turn timers',
      differentGame: 'that was about a different game',
      differentOffer: 'that was about a different offer',
    });
  });

  it('exports the table and nothing else', async () => {
    // The client imports this module from a `'use client'` file, so anything it
    // reaches ships to every visitor. This checks the surface only: a stray
    // *re-export* of `@/lib/store` is caught, a plain `import` used internally
    // is not. What actually keeps the Upstash client out of the browser bundle
    // is that this file imports nothing at all — read it before adding a line.
    const exported: Record<string, unknown> = await import('./refusals');
    expect(Object.keys(exported)).toEqual(['REFUSAL']);
  });
});

describe('the turn timer offered at creation', () => {
  it('is exactly the four choices of GDD §5.3, by value', async () => {
    // Asserting against `TIMER_CHOICES` alone would only say the API accepts
    // whatever that constant holds; §5.3 names the four.
    expect([...TIMER_CHOICES]).toEqual([null, 60_000, 300_000, 86_400_000]);

    for (const timerMs of [null, 60_000, 300_000, 86_400_000]) {
      const created = await read<CreateGameResponse>(
        await postGame(request({ timerMs })),
      );
      expect({ timerMs, stored: created.room.timerMs }).toEqual({
        timerMs,
        stored: timerMs,
      });
    }
  });

  it('defaults to five minutes when none is chosen', async () => {
    for (const body of [{}, undefined]) {
      const created = await read<CreateGameResponse>(
        await postGame(request(body)),
      );
      expect(created.room.timerMs).toBe(DEFAULT_TIMER_MS);
    }
    expect(DEFAULT_TIMER_MS).toBe(300_000);
  });

  it.each([
    ['one that is not offered', 7_000],
    ['a wrong type', '5m'],
    ['a non-integer', 1.5],
    ['a nested object', { ms: 60_000 }],
  ])('400s %s', async (_name, timerMs) => {
    const response = await postGame(request({ timerMs }));
    expect(response.status).toBe(400);
    // The whole sentence: Zod's `path` puts the field in front of our message,
    // and asserting a substring would pass on either half alone.
    expect(await errorOf(response)).toContain('timerMs');
  });

  it('says which field a rejected timer was', async () => {
    const response = await postGame(request({ timerMs: 7_000 }));
    expect(await errorOf(response)).toBe(`timerMs: ${REFUSAL.timerNotOffered}`);
  });
});

describe('the e2e timer escape (GDD §8, bar item 3)', () => {
  it('accepts a very low timer only under the flag, and only off Vercel', async () => {
    expect((await postGame(request({ timerMs: 800 }))).status).toBe(400);

    vi.stubEnv('MORRIS_E2E', '1');
    const response = await postGame(request({ timerMs: 800 }));
    expect(response.status).toBe(200);
    expect((await read<CreateGameResponse>(response)).room.timerMs).toBe(800);

    // Still not anything: the flag widens which timers are offered, not what
    // counts as a timer. Zero is the boundary the `> 0` draws, and a
    // zero-length turn would be claimable before it began.
    for (const timerMs of [0, -5, 1.5, 800.5]) {
      const refused = await postGame(request({ timerMs }));
      expect({ timerMs, status: refused.status }).toEqual({ timerMs, status: 400 });
      await read(refused);
    }
  });

  it('is inert wherever Vercel runs this code', async () => {
    vi.stubEnv('MORRIS_E2E', '1');
    // One variable and no carve-outs: `VERCEL=1` is set in the build, in
    // `vercel dev`, in preview and in production alike. An operator who set the
    // flag on a deploy would otherwise let any client create a one-millisecond
    // clock and claim a forfeit against whoever joined.
    for (const env of [
      { VERCEL: '1' },
      { VERCEL: '1', VERCEL_ENV: 'production' },
      { VERCEL: '1', NEXT_PHASE: 'phase-production-build' },
    ]) {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const refused = await postGame(request({ timerMs: 5 }));
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toContain('timerMs');

      // The four real choices are untouched by the gate.
      const real = await read<CreateGameResponse>(
        await postGame(request({ timerMs: 60_000 })),
      );
      expect(real.room.timerMs).toBe(60_000);
    }

    // A stray `VERCEL_ENV` without `VERCEL` is not a deploy...
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await postGame(request({ timerMs: 800 }))).status).toBe(200);
    // ...and a value that only looks like Vercel's is still Vercel's.
    vi.stubEnv('VERCEL', ' 1 ');
    expect((await postGame(request({ timerMs: 800 }))).status).toBe(400);
  });

  it('compares the flag exactly, from both ends', async () => {
    vi.stubEnv('VERCEL', '');
    // `MORRIS_E2E=1 ` is what an operator leaves in a `.env` file, trailing
    // space and all: under a prefix compare that opens the escape on a
    // self-hosted deploy.
    for (const padded of [' 1 ', '1 ', ' 1', '01', '10']) {
      vi.stubEnv('MORRIS_E2E', padded);
      const response = await postGame(request({ timerMs: 800 }));
      expect(response.status, `MORRIS_E2E=${JSON.stringify(padded)}`).toBe(400);
      await read(response);
    }
  });
});

describe('the action body', () => {
  it.each([
    ['no token', { action: place(0), expectedVersion: 2 }],
    ['an empty token', { token: '', action: place(0), expectedVersion: 2 }],
    ['no action', { token: 'x', expectedVersion: 2 }],
    ['no expectedVersion', { token: 'x', action: place(0) }],
    ['a string version', { token: 'x', action: place(0), expectedVersion: '2' }],
    // A negative version would otherwise reach the store and come back a 409
    // about a version that cannot exist.
    ['a negative version', { token: 'x', action: place(0), expectedVersion: -1 }],
    ['a fractional version', { token: 'x', action: place(0), expectedVersion: 1.5 }],
    ['a fractional point', { token: 'x', action: { type: 'place', point: 1.5 }, expectedVersion: 2 }],
    ['an unknown action type', { token: 'x', action: { type: 'fly', point: 0 }, expectedVersion: 2 }],
    ['an action that is not an object', { token: 'x', action: 'place', expectedVersion: 2 }],
    ['a place with no point', { token: 'x', action: { type: 'place' }, expectedVersion: 2 }],
    ['a move with no destination', { token: 'x', action: { type: 'move', from: 0 }, expectedVersion: 2 }],
    ['a forfeit with no player', { token: 'x', action: { type: 'forfeit' }, expectedVersion: 2 }],
    ['a forfeit against a colour that is not one', { token: 'x', action: { type: 'forfeit', player: 'G' }, expectedVersion: 2 }],
  ])('400s a body with %s', async (_name, body) => {
    const game = await seatedGame();
    const response = await postAction(request(body), ctx(game.id));
    expect(response.status).toBe(400);
    await read(response);
  });

  // The engine's own integer guard would answer 400 for these too, so a status
  // alone says nothing about the schema. Naming the field is what proves the
  // refusal came from `actionSchema`.
  it.each([
    ['a move with a string destination', { type: 'move', from: 0, to: '1' }, 'action.to'],
    ['a remove with a string point', { type: 'remove', point: '1' }, 'action.point'],
  ])('400s %s, and names the field', async (_name, action, field) => {
    const game = await seatedGame();
    const response = await postAction(
      request({ token: game.W, action, expectedVersion: game.version }),
      ctx(game.id),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe(
      `${field}: Invalid input: expected number, received string`,
    );
  });

  it('ignores a key it does not know, like the other endpoints do', async () => {
    const game = await seatedGame();
    const response = await postAction(
      request({
        token: game.W,
        action: place(0),
        expectedVersion: game.version,
        somethingNew: true,
      }),
      ctx(game.id),
    );
    expect(response.status).toBe(200);
    expect((await read<PublicRoom>(response)).game.board[0]).toBe('W');
  });
});

describe('the draw body', () => {
  it.each([
    ['a gameNumber that is a string', { gameNumber: 'two' }],
    ['a gameNumber that is a fraction', { gameNumber: 1.5 }],
    ['a gameNumber that is negative', { gameNumber: -1 }],
    ['a gameNumber that is null', { gameNumber: null }],
    ['an accepting flag that is a string', { accepting: 'yes' }],
    ['an accepting flag that is a number', { accepting: 1 }],
    ['an accepting flag that is null', { accepting: null }],
  ])('400s %s', async (_name, extra) => {
    const game = await seatedGame();
    const response = await postDraw(
      request({ token: game.W, ...extra }),
      ctx(game.id),
    );
    expect(response.status).toBe(400);
    await read(response);
  });
});
