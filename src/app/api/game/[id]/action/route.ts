/**
 * `POST /api/game/[id]/action` — the only way a move reaches the game (GDD
 * §7.3). The body carries the token, the intent, and the version the client
 * believes it is acting on; the engine decides whether the rules allow it. The
 * three other endpoints that change a game — draw, rematch, claim-timeout —
 * carry no move: they agree, reset, or judge the clock.
 */

import {
  ApiFailure,
  REFUSAL,
  actionRequestSchema,
  mutateRoom,
  parseBody,
  requireBothSeats,
} from '@/lib/api';
import { apply } from '@/lib/engine';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const body = await parseBody(request, actionRequestSchema);
  if (!body.ok) return body.response;

  const { token, action, expectedVersion } = body.value;
  const { id } = await params;

  return mutateRoom(id, token, expectedVersion, (room, { seat, now }) => {
    // Guard order here, in /rematch and in /claim-timeout: the room must be
    // playing at all, then its game state is judged, then the route's own rules.
    // Which state each route wants differs — this one needs a live game,
    // /rematch a finished one. /draw is the exception and says so: it judges its
    // own `gameNumber` first, so a tap about a previous game is named as such
    // rather than answered with whatever this game happens to be doing.
    requireBothSeats(room);
    if (room.game.result !== null) throw new ApiFailure(409, REFUSAL.gameOver);

    // A forfeit is the server's to award, after it has checked the clock
    // (GDD §5.3). Letting a client send one here would be a free win. Refused
    // ahead of the turn check so the reason given is the real one, whichever
    // seat sent it.
    if (action.type === 'forfeit') {
      throw new ApiFailure(403, REFUSAL.forfeitIsServerIssued);
    }
    // Resignation is the one thing a player may do out of turn.
    if (action.type !== 'resign' && room.game.turn !== seat) {
      throw new ApiFailure(403, REFUSAL.notYourTurn);
    }

    const game = apply(room.game, action, seat);
    return {
      ...room,
      game,
      // The clock is per turn (GDD §5.3): it keeps running through the removal
      // that a mill earns, and only restarts when the other player is on it.
      turnStartedAt: game.turn === room.game.turn ? room.turnStartedAt : now,
      // A draw offer lapses as soon as either player plays on.
      drawOffer: { W: false, B: false },
    };
  });
}
