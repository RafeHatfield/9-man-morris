/**
 * `POST /api/game/[id]/claim-timeout` — the opponent claims the win when the
 * player on the clock has run out of time (GDD §5.3).
 *
 * There is no auto-forfeit: nothing runs between requests on a serverless host,
 * so the clock is only ever judged here, against the server's own time.
 */

import {
  ApiFailure,
  REFUSAL,
  mutateRoom,
  parseBody,
  requireBothSeats,
  tokenSchema,
} from '@/lib/api';
import { apply } from '@/lib/engine';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const body = await parseBody(request, tokenSchema);
  if (!body.ok) return body.response;

  const { id } = await params;

  return mutateRoom(id, body.value.token, null, (room, { seat, now }) => {
    // An empty seat cannot forfeit: GDD §5.3 awards the win to the *opponent*
    // of the player who ran out, and an unclaimed seat is neither.
    requireBothSeats(room);
    if (room.game.result !== null) throw new ApiFailure(409, REFUSAL.gameOver);
    if (room.timerMs === null) {
      throw new ApiFailure(409, REFUSAL.noTimer);
    }

    const onClock = room.game.turn;
    if (seat === onClock) {
      throw new ApiFailure(403, REFUSAL.yourOwnClock);
    }
    if (now - room.turnStartedAt <= room.timerMs) {
      throw new ApiFailure(409, REFUSAL.clockNotExpired);
    }

    return {
      ...room,
      game: apply(room.game, { type: 'forfeit', player: onClock }, seat),
      // `turnStartedAt` is deliberately left where it is: it marks when the
      // current turn began, and this ends the game rather than starting a turn.
      // A replayed claim is refused by the finished-game check above, not by
      // moving the clock.
      // The game is over; an outstanding offer to draw it is not still standing.
      drawOffer: { W: false, B: false },
    };
  });
}
