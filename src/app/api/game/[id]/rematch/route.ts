/**
 * `POST /api/game/[id]/rematch` — offer and accept in one endpoint (GDD §5.4).
 * The first call marks the caller; the second, from the other seat, resets the
 * room to a fresh game with the colours swapped. Same URL, same tokens.
 */

import {
  ApiFailure,
  REFUSAL,
  mutateRoom,
  parseBody,
  requireBothSeats,
  tokenSchema,
} from '@/lib/api';
import { initialState } from '@/lib/engine';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const body = await parseBody(request, tokenSchema);
  if (!body.ok) return body.response;

  const { id } = await params;

  return mutateRoom(id, body.value.token, null, (room, { seat, now }) => {
    // As with a draw offer: a flag set before the room had an opponent would be
    // accepted by that opponent's first tap, on a game they never played.
    requireBothSeats(room);
    if (room.game.result === null) {
      throw new ApiFailure(409, REFUSAL.gameNotOver);
    }
    // Idempotent: asking twice is not an acceptance, and does not burn a version.
    if (room.rematch[seat]) return null;

    const rematch =
      seat === 'W'
        ? { ...room.rematch, W: true }
        : { ...room.rematch, B: true };
    if (!rematch.W || !rematch.B) return { ...room, rematch };

    return {
      ...room,
      // Colours swap: the token that was Black moves first in the new game,
      // because White always does (GDD §9).
      players: { W: room.players.B, B: room.players.W },
      game: initialState(),
      turnStartedAt: now,
      rematch: { W: false, B: false },
      drawOffer: { W: false, B: false },
      gameNumber: room.gameNumber + 1,
    };
  });
}
