/**
 * The parts the route handlers share: reading a body, finding the caller's
 * seat, and writing a mutation through the store under optimistic concurrency.
 *
 * The server is the only authority (GDD §7.3). A route handler never edits
 * `room.game` by hand — it hands the engine an action and stores what comes back.
 */

import type { ZodType } from 'zod';

import { IllegalActionError } from '@/lib/engine';
import type { Player } from '@/lib/engine';
import {
  RoomNotFoundError,
  VersionConflictError,
  getStore,
} from '@/lib/store';
import type { Room, RoomStore } from '@/lib/store';

import { REFUSAL } from './refusals';
import { publicRoom } from './types';
import type { ApiError, PublicRoom } from './types';

// — the store, with a seam for tests ——————————————————————————————————

let storeOverride: RoomStore | null = null;

/** The store every handler writes through. */
export function apiStore(): RoomStore {
  return storeOverride ?? getStore();
}

/**
 * Tests only: point the API at a fresh `MemoryStore`. `getStore()` memoises a
 * process-wide instance on purpose, so the seam lives here rather than there.
 * Pass `null` to go back to the real one.
 */
export function setApiStore(store: RoomStore | null): void {
  storeOverride = store;
}

// — failures ——————————————————————————————————————————————————————————

/**
 * A refusal with the status it should carry. Thrown from inside a mutation, where
 * returning a `Response` is not an option, and turned into one by `mutateRoom`.
 */
export class ApiFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
  }
}

/**
 * Runs a handler's work and answers anything it throws with a 500 in the
 * `ApiError` shape. Without this, an error this layer does not know — a
 * `CorruptRoomError` from `@/lib/store`, say, which `handlers.test.ts` throws
 * from a fake store to reach this path — escapes into the framework, which
 * answers with its own HTML-ish 500: no `error` field for the client to read,
 * and no `Cache-Control`.
 */
export async function guarded(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    // The message is never put on the wire: it can name keys, ids, or worse.
    // The server log is where an operator reads it.
    console.error(
      '[api] unhandled failure:',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    return errorResponse(500, REFUSAL.serverError);
  }
}

/**
 * Every response the route handlers produce, success or failure. `no-store` is
 * on all of them: the polling `GET` (GDD §7.3, every 1.5 s) must never be
 * answered from a browser or intermediary cache, and `dynamic =
 * 'force-dynamic'` governs Next's own build and data caches, not HTTP ones.
 *
 * What does not come through here, and so carries no header: whatever the
 * framework answers when no handler runs at all — a 405 with an empty body for
 * a method the route does not export, a 204 for a preflight, and a plain-text
 * 500 for `TRACE`, which the App Router has no way to export a handler for.
 * Nothing this app sends is one of those requests. (`HEAD` on the polled `GET`
 * is not one of them: the framework derives it from `GET`, so it comes through
 * here and carries the header.)
 */
export function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

/** Every failure has the same body shape, so a client has one thing to read. */
export function errorResponse(
  status: number,
  error: string,
  room?: PublicRoom,
): Response {
  const body: ApiError = room === undefined ? { error } : { error, room };
  return jsonResponse(status, body);
}


// — request bodies —————————————————————————————————————————————————————

/**
 * What `parseBody` answers with. Module-local: it is inferred at every call
 * site, and nothing outside this file has ever named it.
 */
type ParsedBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

/**
 * Reads and validates a JSON body. Anything the schema rejects — a non-JSON
 * body, a missing field, a wrong type — is a 400, never a 500. An empty body —
 * or one that is nothing but whitespace, which is what a `POST` with no body
 * looks like through some clients — is read as `{}`, so it is fine for the
 * endpoints whose body is empty and a missing-field 400 for the ones whose is
 * not.
 *
 * These 400s carry no `room`: they are answered before any room is read, and a
 * client that sent an unparseable body has a bug, not a stale board.
 */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<ParsedBody<T>> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return { ok: false, response: errorResponse(400, REFUSAL.badBody) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      response: errorResponse(400, describe(result.error.issues)),
    };
  }
  return { ok: true, value: result.data };
}

function describe(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  return issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message,
    )
    .join('; ');
}

// — reads ——————————————————————————————————————————————————————————————

/** `GET /api/game/[id]`: the public view, or a 404. Open to anyone (GDD §6.4). */
export async function readRoom(id: string): Promise<Response> {
  return guarded(async () => {
    const room = await apiStore().get(id);
    if (room === null) return errorResponse(404, REFUSAL.roomNotFound);
    return jsonResponse(200, publicRoom(room, Date.now()));
  });
}

/**
 * Refuses everything — a resignation included — while a room is still waiting
 * for its second player (GDD §5.1: play proceeds once the link has been
 * opened). The only request such a room accepts is the join itself.
 */
export function requireBothSeats(room: Room): void {
  if (room.players.W === null || room.players.B === null) {
    throw new ApiFailure(409, REFUSAL.waitingForOpponent);
  }
}

/** Which seat a token holds, if any. The only place tokens are compared. */
function seatOf(room: Room, token: string): Player | null {
  if (token === room.players.W) return 'W';
  if (token === room.players.B) return 'B';
  return null;
}

// — writes —————————————————————————————————————————————————————————————

interface MutationContext {
  /** The seat the caller's token holds. */
  seat: Player;
  /** The server's clock, read once per attempt. The only clock there is (§5.3). */
  now: number;
}

/**
 * Computes the next room. Returns `null` for "nothing to change", which is how
 * the idempotent endpoints answer a repeated offer without burning a version.
 * Throws {@link ApiFailure} for a refusal, or `IllegalActionError` from the engine.
 */
type RoomMutation = (room: Room, ctx: MutationContext) => Room | null;

/**
 * How many times a write is recomputed when a concurrent one lands in between.
 * Two players can tap Rematch at the same instant; neither should see a conflict
 * they did not ask for. Shared with `/join`, which runs its own loop because it
 * has no token to resolve and so cannot use `mutateRoom`.
 */
export const MAX_WRITE_ATTEMPTS = 3;

/**
 * The write path for every endpoint that changes a game: load the room, place
 * the caller, compute the next room, and store it under optimistic
 * concurrency. `/join` is not one of them — it has no token to resolve, so it
 * runs the same shape of loop itself.
 *
 * `expectedVersion` is the version the client pinned (the action endpoint),
 * checked before the mutation is even asked to run, or `null` for the endpoints
 * that carry no version, which use the version they just read and retry a lost
 * race instead of reporting it.
 */
export async function mutateRoom(
  id: string,
  token: string,
  expectedVersion: number | null,
  mutation: RoomMutation,
): Promise<Response> {
  return guarded(() => write(id, token, expectedVersion, mutation));
}

/** `mutateRoom` without the safety net, which is the only thing it adds. */
async function write(
  id: string,
  token: string,
  expectedVersion: number | null,
  mutation: RoomMutation,
): Promise<Response> {
  const store = apiStore();

  for (let attempt = 1; ; attempt++) {
    const room = await store.get(id);
    if (room === null) return errorResponse(404, REFUSAL.roomNotFound);

    const now = Date.now();
    // Every refusal below that has a room to name hands back the room the
    // server actually has, so the client can resync from the refusal itself.
    // The exception is the room that expires mid-write, which is a 404.
    const view = (): PublicRoom => publicRoom(room, now);

    const seat = seatOf(room, token);
    if (seat === null) return errorResponse(403, REFUSAL.notAPlayer, view());

    // The version is checked before the mutation runs, not just at write time:
    // a client acting on a board the server has moved past must be told to
    // resync (GDD §7.3), whatever else is also wrong with what it sent. Judging
    // the turn or the legality of the move first would answer a stale action
    // with 403 or 400 and leave the client with no way to notice it is behind.
    if (expectedVersion !== null && expectedVersion !== room.version) {
      const conflict = new VersionConflictError(
        id,
        expectedVersion,
        room.version,
      );
      return errorResponse(409, conflict.message, view());
    }

    try {
      const next = mutation(room, { seat, now });
      if (next === null) return jsonResponse(200, view());

      // The store re-checks the version at write time, so computing `next` from
      // the room read above cannot clobber a writer that landed in between.
      // `room.version`, not `expectedVersion ?? room.version`: the check above
      // has already answered 409 for any other value, so the two are equal by
      // construction and the `??` only read as though the client's pin were
      // being re-asserted here. What guards this write is that the store
      // re-checks this version at write time.
      const written = await store.update(id, () => next, room.version);
      return jsonResponse(200, publicRoom(written, now));
    } catch (error) {
      if (error instanceof ApiFailure) {
        return errorResponse(error.status, error.message, view());
      }
      if (error instanceof IllegalActionError) {
        return errorResponse(400, error.message, view());
      }
      if (error instanceof RoomNotFoundError) {
        return errorResponse(404, REFUSAL.roomNotFound);
      }
      if (error instanceof VersionConflictError) {
        if (expectedVersion === null && attempt < MAX_WRITE_ATTEMPTS) continue;

        const current = await store.get(id);
        // A conflict means another writer had the room a moment ago. If it is
        // not there now it is gone, and "gone" is a 404 — not a conflict about
        // a version the client can never fetch. (A store that notices the room
        // is missing at write time raises `RoomNotFoundError` instead, handled
        // just above; this is the same answer reached from the other side.)
        if (current === null) return errorResponse(404, REFUSAL.roomNotFound);

        // The store's sentence names the version the caller pinned — which is
        // meaningful to `/action`, and meaningless to an endpoint that pins
        // none, so those get our own wording.
        const message =
          expectedVersion === null ? REFUSAL.roomBusy : error.message;
        return errorResponse(409, message, publicRoom(current, Date.now()));
      }
      throw error;
    }
  }
}
