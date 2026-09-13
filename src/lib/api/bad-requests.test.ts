/**
 * The other half of the GDD §8.2 floor: every endpoint answers a malformed body
 * with a 400 and an unknown room with a 404 — never a 500, and never a write.
 *
 * The wrong-token, wrong-turn and stale-version half is in `quality-bar.test.ts`;
 * what `parseBody` and the shared write path do with those requests is in
 * `handlers.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { REFUSAL } from './refusals';
import {
  brokenRequest,
  createdGame,
  ctx,
  errorOf,
  getGame,
  getRequest,
  installHarness,
  place,
  postAction,
  postClaimTimeout,
  postDraw,
  postGame,
  postJoin,
  postRematch,
  rawRequest,
  read,
  request,
  seatedGame,
  stored,
} from './test-harness';

installHarness();

describe('a malformed body', () => {
  /** `object` bodies are structurally acceptable where the body may be empty. */
  const bodies: [name: string, raw: string, object: boolean][] = [
    ['a truncated object', '{"token": ', false],
    ['null', 'null', false],
    ['an array', '[]', false],
    ['a number', '42', false],
    ['a prototype-pollution attempt', '{"__proto__":{"polluted":true}}', true],
    ['null fields', '{"token":null,"action":null,"expectedVersion":null}', true],
  ];

  /**
   * `open` endpoints accept an empty body; the others want a token, and
   * `/action` a whole move besides. What each *should* answer to a given body
   * follows from that, and nothing may ever throw.
   */
  const endpoints: [
    name: string,
    open: boolean,
    call: (body: Request, id: string) => Promise<Response>,
  ][] = [
    ['POST /api/game', true, (body) => postGame(body)],
    ['POST /api/game/[id]/join', true, (body, id) => postJoin(body, ctx(id))],
    [
      'POST /api/game/[id]/action',
      false,
      (body, id) => postAction(body, ctx(id)),
    ],
    [
      'POST /api/game/[id]/claim-timeout',
      false,
      (body, id) => postClaimTimeout(body, ctx(id)),
    ],
    [
      'POST /api/game/[id]/rematch',
      false,
      (body, id) => postRematch(body, ctx(id)),
    ],
    ['POST /api/game/[id]/draw', false, (body, id) => postDraw(body, ctx(id))],
  ];

  it.each(endpoints)(
    '%s answers the status each body earns',
    async (_name, open, call) => {
      for (const [, raw, isObject] of bodies) {
        // A fresh room per body: an `open` endpoint that accepts one mutates.
        const created = await createdGame();
        const before = await stored(created.roomId);

        const response = await call(rawRequest(raw), created.roomId);
        await read(response);
        const expected = isObject && open ? 200 : 400;

        expect({ raw, status: response.status }).toEqual({
          raw,
          status: expected,
        });
        // Nothing was polluted and, where the request was refused, nothing moved.
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        if (response.status !== 200) {
          expect(await stored(created.roomId)).toEqual(before);
        }
      }
    },
  );

  it("400s a body that is not JSON, in the API's own words", async () => {
    const game = await seatedGame(60_000);
    for (const response of [
      await postGame(brokenRequest()),
      await postJoin(brokenRequest(), ctx(game.id)),
      await postAction(brokenRequest(), ctx(game.id)),
      await postClaimTimeout(brokenRequest(), ctx(game.id)),
      await postRematch(brokenRequest(), ctx(game.id)),
      await postDraw(brokenRequest(), ctx(game.id)),
    ]) {
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(REFUSAL.badBody);
    }
  });
});

describe('an unknown room', () => {
  it('404s at every endpoint, the read included', async () => {
    const game = await seatedGame(60_000);
    // Each route destructures its own `id` from its own `params`, so resolving
    // an id is a per-route property and one probe says nothing about the rest.
    const gone = 'ZZZZZZZZ';
    for (const response of [
      await getGame(getRequest(), ctx(gone)),
      await postJoin(request({}), ctx(gone)),
      await postAction(
        request({ token: game.W, action: place(0), expectedVersion: 1 }),
        ctx(gone),
      ),
      await postClaimTimeout(request({ token: game.W }), ctx(gone)),
      await postRematch(request({ token: game.W }), ctx(gone)),
      await postDraw(request({ token: game.W }), ctx(gone)),
    ]) {
      expect(response.status).toBe(404);
      expect(await errorOf(response)).toBe(REFUSAL.roomNotFound);
    }
  });

  it('is what a room id that only nearly matches gets', async () => {
    const game = await seatedGame(60_000);
    expect(game.id).toBe(game.id.toUpperCase());

    // Ids are uppercase and travel in a link (GDD §5.1); nothing folds case or
    // trims, and doing either on the read alone would make it work where every
    // write still 404s.
    for (const wrong of [game.id.toLowerCase(), `${game.id} `, ` ${game.id}`]) {
      const readBack = await getGame(getRequest(), ctx(wrong));
      expect(readBack.status, `GET on \`${wrong}\``).toBe(404);
      await read(readBack);

      const write = await postDraw(request({ token: game.W }), ctx(wrong));
      expect(write.status, `/draw on \`${wrong}\``).toBe(404);
      await read(write);
    }

    // The same body on the id as issued is accepted, so those 404s are about
    // the id and not about the request.
    const right = await postDraw(request({ token: game.W }), ctx(game.id));
    expect(right.status).toBe(200);
    await read(right);
  });
});
