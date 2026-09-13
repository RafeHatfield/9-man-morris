/**
 * The client half of the wire contract (GDD §7.3). One rule runs through the
 * whole file: **this client acts on a reply only when the reply is this
 * server's, about this room.** A 2xx is a success only if the body is the type
 * that was asked for; a refusal is believed — status acted on, room adopted —
 * only inside this server's own error envelope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFUSAL } from '@/lib/api/refusals';
import type { PublicRoom } from '@/lib/api/types';
import { initialState, type GameState } from '@/lib/engine';
import {
  REQUEST_TIMEOUT_MS,
  createGame,
  fetchRoom,
  joinRoom,
  offerDraw,
  resignGame,
  sendAction,
} from './api';

/** Every request in this file is about this room, and every reply must be. */
const ROOM = 'ROOM1234';

function room(
  over: Partial<PublicRoom> & { version: number; gameNumber: number },
): PublicRoom {
  return {
    id: ROOM,
    game: initialState(),
    timerMs: null,
    turnStartedAt: 0,
    serverNow: 1_000,
    seats: { W: true, B: true },
    clockRunning: false,
    rematch: { W: false, B: false },
    drawOffer: { W: false, B: false },
    ...over,
  };
}

const LIVE = room({ version: 4, gameNumber: 1 });

/** Every call the stub saw: the method, and the parsed body. */
interface Seen {
  method: string;
  body: unknown;
}

let seen: Seen[] = [];

/** Queues one canned response per call, in order; the last one repeats. */
function stubFetch(responses: readonly { status: number; body: unknown }[]) {
  let call = 0;
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
    seen.push({
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

beforeEach(() => {
  seen = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('every request', () => {
  it('reads a refusal as a result, never as a throw', async () => {
    stubFetch([{ status: 409, body: { error: 'stale', room: LIVE } }]);
    const result = await sendAction(ROOM, 't', { type: 'resign' }, 1);
    expect(result).toMatchObject({ ok: false, status: 409, error: 'stale' });
    // And its room is what the caller adopts: a rejected tap is also a resync.
    expect(result.ok ? null : result.room?.version).toBe(4);
  });

  it('turns a dead network into a result too', async () => {
    // A throw would be an unhandled rejection inside the poll's gate, leaving
    // the page on "Loading…" with nothing to retry it.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('timed out')));
    expect(await fetchRoom(ROOM)).toMatchObject({ ok: false, status: 0 });
  });

  it('abandons a response whose body never arrives', async () => {
    // A browser does not time `fetch` out on its own, and one hung request holds
    // the `SingleFlight` gate shut for ever. The timer covers the body too.
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            }),
        } as unknown as Response),
      );
      const pending = fetchRoom(ROOM);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      await expect(pending).resolves.toMatchObject({ ok: false, status: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a 2xx is only a success if the reply is the reply', () => {
  it('refuses a 200 that is not a room', async () => {
    // What a captive portal or an edge error page answers; somebody else's
    // JSON; and this server's own shape with one field of the wrong type.
    for (const body of [
      '<html>sign in to continue</html>',
      JSON.stringify({ status: 'ok' }),
      JSON.stringify({ ...LIVE, version: '4' }),
    ]) {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response(body, { status: 200 })),
      );
      expect((await fetchRoom(ROOM)).ok).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it('refuses a seat with no token, which would be stored unread', async () => {
    // Absent, and — the case a plain `typeof value === 'string'` waves through —
    // present and empty: either is stored and then refused for ever.
    for (const body of [
      { colour: 'B', room: LIVE },
      { token: '', colour: 'B', room: LIVE },
    ]) {
      stubFetch([{ status: 200, body }]);
      expect((await joinRoom(ROOM)).ok).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it('accepts the real thing — the control for every refusal above', async () => {
    stubFetch([{ status: 200, body: LIVE }]);
    const result = await fetchRoom(ROOM);
    expect(result.ok && result.data.version).toBe(4);
    vi.unstubAllGlobals();
    stubFetch([{ status: 200, body: { token: 't', colour: 'B', room: LIVE } }]);
    expect((await joinRoom(ROOM)).ok).toBe(true);
  });
});

describe('a reply has to be about the room that was asked for', () => {
  // Another room's genuine `PublicRoom`: well-formed, and not ours. Adopting one
  // draws a stranger's board — and a version only climbs, so the higher one makes
  // `adoptRoom` reject every genuine poll after it, for good.
  const elsewhere = { ...LIVE, id: 'OTHERRM1', version: 900 };

  it('refuses it on a 200, and drops it off a refusal', async () => {
    stubFetch([{ status: 200, body: elsewhere }]);
    expect((await fetchRoom(ROOM)).ok).toBe(false);

    // The same body on a 409: the status is this server's and the room is not,
    // so the status stands and the room is dropped.
    vi.unstubAllGlobals();
    stubFetch([{ status: 409, body: { error: 'stale', room: elsewhere } }]);
    const result = await sendAction(ROOM, 't', { type: 'resign' }, 1);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok ? true : result.room).toBeUndefined();
  });

  it('refuses a seat, or a created room, carrying a stranger’s room', async () => {
    stubFetch([
      { status: 200, body: { token: 't', colour: 'B', room: elsewhere } },
    ]);
    expect((await joinRoom(ROOM)).ok).toBe(false);

    // `createGame` has no id to compare against yet, so its check is that the
    // reply agrees with itself: the room it hands back is the room it names.
    vi.unstubAllGlobals();
    const body = { roomId: ROOM, token: 't', colour: 'W', room: elsewhere };
    stubFetch([{ status: 200, body }]);
    expect((await createGame(null)).ok).toBe(false);
  });
});

describe("a refusal is believed only in this server's own envelope", () => {
  it('drops a room that is not a room, so nothing dereferences it', async () => {
    for (const bad of [{ version: 999, gameNumber: 1 }, null]) {
      stubFetch([{ status: 409, body: { error: 'stale', room: bad } }]);
      const result = await sendAction(ROOM, 't', { type: 'resign' }, 1);
      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(result.ok ? true : result.room).toBeUndefined();
      vi.unstubAllGlobals();
    }
  });

  it('will not act on a status that did not come with that envelope', async () => {
    // The shape an edge 404, a proxy error page or a mid-redeploy has. Read as
    // a 404, one of these ends a live game for good (`useRoom` stops polling).
    for (const body of ['<html>404</html>', JSON.stringify({ message: 'no' })]) {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response(body, { status: 404 })),
      );
      expect(await fetchRoom(ROOM)).toMatchObject({ ok: false, status: 0 });
      vi.unstubAllGlobals();
    }

    // This server's own 404 is the one that is acted on.
    stubFetch([{ status: 404, body: { error: REFUSAL.roomNotFound } }]);
    expect(await fetchRoom(ROOM)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('resignGame', () => {
  const conflict = (next: PublicRoom) => ({
    status: 409,
    body: { error: 'version conflict', room: next },
  });
  const versions = () =>
    seen.map((call) => (call.body as { expectedVersion: number }).expectedVersion);

  it('sends the version the player was looking at, and re-pins on a conflict', async () => {
    // The moment a player decides to resign is the moment an opponent's move is
    // most likely to be in flight, and a resignation is legal at every version,
    // so a 409 is re-pinned rather than losing the tap (§4.6).
    const moved = room({ version: 5, gameNumber: 1 });
    stubFetch([conflict(moved), { status: 200, body: moved }]);
    expect((await resignGame(ROOM, 't', LIVE)).ok).toBe(true);
    expect(seen[0].body).toEqual({
      token: 't',
      action: { type: 'resign' },
      expectedVersion: 4,
    });
    expect(versions()).toEqual([4, 5]);
  });

  it('re-sends nothing but a version conflict in the same, unfinished game', async () => {
    const over: GameState = {
      ...initialState(),
      result: { winner: 'B', reason: 'resign' },
    };
    const sentOnce = [
      // A rematch (§5.4): a game the player has never seen, in the other colour.
      conflict(room({ version: 9, gameNumber: 2 })),
      conflict(room({ version: 9, gameNumber: 1, game: over })),
      // Refused for the room's state: the version is unchanged, so re-sending
      // would be a byte-for-byte repeat of a request already answered.
      { status: 409, body: { error: REFUSAL.gameOver, room: LIVE } },
      { status: 403, body: { error: REFUSAL.notAPlayer, room: LIVE } }, // not 409
    ] as const;
    for (const response of sentOnce) {
      seen = [];
      stubFetch([response]);
      expect((await resignGame(ROOM, 't', LIVE)).ok).toBe(false);
      expect(seen).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });

  it('gives up after three attempts rather than chasing a moving version', async () => {
    stubFetch([5, 6, 7].map((v) => conflict(room({ version: v, gameNumber: 1 }))));
    expect(await resignGame(ROOM, 't', LIVE)).toMatchObject({ status: 409 });
    expect(versions()).toEqual([4, 5, 6]);
  });
});

describe('offerDraw', () => {
  it('says which game, and what the button said it would do', async () => {
    // Both travel with the tap because the room the player read may be a poll
    // old — or arbitrarily old in a background tab, which does not poll at all.
    // `gameNumber` is the game the button was drawn from, not the room as it is:
    // a value from a fresh read would always match, and would say nothing.
    stubFetch([{ status: 200, body: { ...LIVE, gameNumber: 2, version: 20 } }]);
    expect((await offerDraw(ROOM, 't', LIVE, false)).ok).toBe(true);
    expect(seen[0].body).toEqual({ token: 't', gameNumber: 1, accepting: false });

    const offered = { ...LIVE, drawOffer: { W: false, B: true } };
    vi.unstubAllGlobals();
    stubFetch([{ status: 200, body: offered }]);
    await offerDraw(ROOM, 't', offered, true);
    expect(seen[1].body).toMatchObject({ accepting: true });
  });

  it('adopts a refusal rather than retrying it', async () => {
    stubFetch([
      { status: 409, body: { error: REFUSAL.differentOffer, room: LIVE } },
    ]);
    const result = await offerDraw(ROOM, 't', LIVE, false);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok ? null : result.room?.version).toBe(4);
    expect(seen).toHaveLength(1);
  });
});
