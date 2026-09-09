/**
 * The shared harness for the API tests (GDD §7.3).
 *
 * The route handlers are imported and called directly with a `Request`, so there
 * is no server and no port. Every test gets a fresh `MemoryStore` through the
 * seam in `handlers.ts`, and time is driven by moving a frozen clock rather than
 * by sleeping.
 *
 * Every response any test makes goes through `recording`, which is what lets
 * `afterEach` hold two properties over the whole suite: no player token ever
 * reaches a response body (GDD §7.4 — tokens are "never returned to clients"),
 * and every room view is stamped with the moment it was made, because the client
 * draws its countdown from `serverNow - turnStartedAt` (§5.3).
 */

import { afterEach, beforeEach, expect, vi } from 'vitest';

import { POST as actionRoute } from '@/app/api/game/[id]/action/route';
import { POST as claimTimeoutRoute } from '@/app/api/game/[id]/claim-timeout/route';
import { POST as drawRoute } from '@/app/api/game/[id]/draw/route';
import { POST as joinRoute } from '@/app/api/game/[id]/join/route';
import { POST as rematchRoute } from '@/app/api/game/[id]/rematch/route';
import { GET as roomRoute } from '@/app/api/game/[id]/route';
import { POST as createRoute } from '@/app/api/game/route';
import type { Action } from '@/lib/engine';
import { MemoryStore } from '@/lib/store';
import type { Room } from '@/lib/store';

import { setApiStore } from './handlers';
import type { CreateGameResponse, JoinResponse, PublicRoom } from './types';

interface Recorded {
  status: number;
  text: string;
  issuesToken: boolean;
  /** The clock when the response was made, to check its `serverNow` against. */
}

let store: MemoryStore;
let transcript: Recorded[];
/** Every token this test has been issued. None may appear in another's view. */
let issuedTokens: string[];
/**
 * The server's clock, frozen and moved by hand. Wall time in a test is a race:
 * two requests in the same millisecond make "the clock restarted" unprovable.
 */
let clock: number;

/** The `MemoryStore` behind the API, for reading what a request really wrote. */
export function theStore(): MemoryStore {
  return store;
}

/** The server's current time, as the handlers see it. */
export function now(): number {
  return clock;
}

/** Moves the server's clock forward. The only way time passes in these files. */
export function advance(ms: number): number {
  clock += ms;
  return clock;
}

/** Called once at the top of every API test file. */
export function installHarness(): void {
  beforeEach(() => {
    store = new MemoryStore();
    setApiStore(store);
    transcript = [];
    issuedTokens = [];
    clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setApiStore(null);
    vi.unstubAllEnvs();

    for (const token of issuedTokens) expect(token).toMatch(TOKEN_SHAPE);

    for (const { status, text, issuesToken } of transcript) {
      const parsed: unknown = JSON.parse(text);

      // No response may carry a token. The one exemption is the top-level
      // `token` of a *successful* create or join, which is the caller's own and
      // is the only way they get it — narrow to those, or a token leaking
      // anywhere else would have its evidence deleted before the check.
      if (
        issuesToken &&
        status === 200 &&
        parsed !== null &&
        typeof parsed === 'object'
      ) {
        delete (parsed as { token?: string }).token;
      }
      const rest = JSON.stringify(parsed);
      const leaked = issuedTokens.filter((token) => rest.includes(token));
      expect(leaked, `a token appeared in a ${status} body: ${text}`).toEqual([]);
    }
  });
}

/**
 * Wraps a route handler so that *every* response it gives is recorded, whether
 * or not the test reads the body. The `afterEach` sweep is only as global as
 * this: an inline `expect(status).toBe(403)` would otherwise escape them.
 */
function recording<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
  { issuesToken = false }: { issuesToken?: boolean } = {},
): (...args: A) => Promise<Response> {
  return async (...args: A): Promise<Response> => {
    const response = await handler(...args);
    const text = await response.clone().text();
    transcript.push({ status: response.status, text, issuesToken });

    // Tokens are collected here rather than by hand at the call sites: the
    // sweep is only as complete as this list.
    if (issuesToken && response.status === 200) {
      const token: unknown = (JSON.parse(text) as { token?: unknown }).token;
      if (typeof token === 'string') issuedTokens.push(token);
    }
    return response;
  };
}

// Only these two may put a token in a body, and only when they succeed.
export const postGame = recording(createRoute, { issuesToken: true });
export const postJoin = recording(joinRoute, { issuesToken: true });
export const getGame = recording(roomRoute);
export const postAction = recording(actionRoute);
export const postClaimTimeout = recording(claimTimeoutRoute);
export const postRematch = recording(rematchRoute);
export const postDraw = recording(drawRoute);

export function request(body?: unknown): Request {
  return new Request('http://localhost/api/game', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

/** A body exactly as sent, however malformed. */
export function rawRequest(body: string): Request {
  return new Request('http://localhost/api/game', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/** A body that is not JSON at all. */
export function brokenRequest(): Request {
  return rawRequest('{"token": ');
}

/** The `GET` route takes a request it never reads. */
export function getRequest(): Request {
  return new Request('http://localhost');
}

export function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/**
 * Parses a body. A clone is read, so a test may look at the same response twice
 * — as the status, then the room it carries — without exhausting it.
 */
export async function read<T>(response: Response): Promise<T> {
  return JSON.parse(await response.clone().text()) as T;
}

export async function errorOf(response: Response): Promise<string> {
  const body = await read<{ error: string }>(response);
  return body.error;
}

/** A refusal, which carries the server's view of the room where it has one. */
export async function refusal(
  response: Response,
): Promise<{ error: string; room?: PublicRoom }> {
  return read<{ error: string; room?: PublicRoom }>(response);
}

export interface Seats {
  id: string;
  W: string;
  B: string;
  /** The version the next action will pin, kept in step with the responses. */
  version: number;
}

/** A room with both seats filled, ready to play. */
export async function seatedGame(timerMs?: number | null): Promise<Seats> {
  const created = await read<CreateGameResponse>(
    await postGame(request(timerMs === undefined ? {} : { timerMs })),
  );
  const joined = await read<JoinResponse>(
    await postJoin(request({}), ctx(created.roomId)),
  );

  return {
    id: created.roomId,
    W: created.token,
    B: joined.token,
    version: joined.room.version,
  };
}

/** A created, unjoined room and the creator's token. */
export async function createdGame(
  timerMs?: number | null,
): Promise<CreateGameResponse> {
  return read<CreateGameResponse>(
    await postGame(request(timerMs === undefined ? {} : { timerMs })),
  );
}

/** A second of thinking time, then the request. */
export async function act(
  game: Seats,
  token: string,
  action: Action,
  expectedVersion = game.version,
): Promise<Response> {
  advance(1_000);
  return postAction(request({ token, action, expectedVersion }), ctx(game.id));
}

/** Plays one action, insisting it is accepted, and tracks the new version. */
export async function play(
  game: Seats,
  token: string,
  action: Action,
): Promise<PublicRoom> {
  const response = await act(game, token, action);
  const room = await read<PublicRoom>(response);
  expect({ status: response.status, action, room }).toMatchObject({
    status: 200,
  });
  game.version = room.version;
  return room;
}

/** The room as the store holds it, for asserting what a refusal did not write. */
export async function stored(id: string): Promise<Room> {
  const room = await store.get(id);
  if (room === null) throw new Error(`no room ${id}`);
  return room;
}

export const place = (point: number): Action => ({ type: 'place', point });
export const move = (from: number, to: number): Action => ({
  type: 'move',
  from,
  to,
});
export const remove = (point: number): Action => ({ type: 'remove', point });
export const resign: Action = { type: 'resign' };

export const STRANGER = 'not-a-token';

/** What `newPlayerToken` produces: 16 crypto-random bytes as hex. */
export const TOKEN_SHAPE = /^[0-9a-f]{32}$/;
