/**
 * `POST /api/game/[id]/join` — the first other visitor claims Black and gets
 * their own token (GDD §5.1). Anyone after that is read-only: a 409.
 */

import {
  MAX_WRITE_ATTEMPTS,
  REFUSAL,
  apiStore,
  guarded,
  errorResponse,
  joinSchema,
  jsonResponse,
  parseBody,
  publicRoom,
} from '@/lib/api';
import type { JoinResponse } from '@/lib/api';
import {
  RoomNotFoundError,
  VersionConflictError,
  newPlayerToken,
} from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const body = await parseBody(request, joinSchema);
  if (!body.ok) return body.response;

  const { id } = await params;
  // This route cannot use `mutateRoom` — the joiner has no token to resolve —
  // so it borrows the safety net directly.
  return guarded(() => claimSeat(id));
}

async function claimSeat(id: string): Promise<Response> {
  const store = apiStore();

  for (let attempt = 1; ; attempt++) {
    const room = await store.get(id);
    if (room === null) return errorResponse(404, REFUSAL.roomNotFound);
    if (room.players.B !== null) {
      return errorResponse(409, REFUSAL.seatsTaken, publicRoom(room, Date.now()));
    }

    const now = Date.now();
    const token = newPlayerToken();
    try {
      const joined = await store.update(
        id,
        (current) => ({
          ...current,
          players: { ...current.players, B: token },
          // The clock starts when the game can actually be played (GDD §5.1:
          // create, share, wait). Stamping it at creation would run White's
          // timer down while the link sat unopened in a text message.
          turnStartedAt: now,
        }),
        room.version,
      );
      const response: JoinResponse = {
        token,
        colour: 'B',
        room: publicRoom(joined, now),
      };
      return jsonResponse(200, response);
    } catch (error) {
      if (error instanceof RoomNotFoundError) {
        return errorResponse(404, REFUSAL.roomNotFound);
      }
      if (error instanceof VersionConflictError) {
        // Someone wrote to the room in between. Usually the other joiner, but
        // the seated player moving is a write too, so re-read before saying
        // anything about the seat: a busy room is not a full one.
        if (attempt < MAX_WRITE_ATTEMPTS) continue;

        const current = await store.get(id);
        if (current === null) return errorResponse(404, REFUSAL.roomNotFound);
        return errorResponse(
          409,
          current.players.B === null ? REFUSAL.joinRaced : REFUSAL.seatsTaken,
          publicRoom(current, Date.now()),
        );
      }
      throw error;
    }
  }
}
