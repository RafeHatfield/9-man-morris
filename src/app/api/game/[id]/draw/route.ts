/**
 * `POST /api/game/[id]/draw` — offer and accept in one endpoint (GDD §4.6).
 * The first call is the offer; the same call from the other seat accepts it and
 * the engine ends the game as a draw.
 */

import {
  ApiFailure,
  REFUSAL,
  drawSchema,
  mutateRoom,
  parseBody,
  requireBothSeats,
} from '@/lib/api';
import { agreeDraw, opponentOf } from '@/lib/engine';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const body = await parseBody(request, drawSchema);
  if (!body.ok) return body.response;

  const { id } = await params;

  const { token, gameNumber, accepting } = body.value;

  return mutateRoom(id, token, null, (room, { seat }) => {
    // An offer made before the room had an opponent would otherwise be waiting
    // to be accepted by the first tap of a player who never saw it.
    requireBothSeats(room);

    // Which game the tap was about, judged after the seats and before the
    // game's state: a room still waiting for a second player is not playing a
    // game to be stale about, while a room that has moved on to another game
    // would answer every later question about the wrong position. Accepting a draw ends a live game
    // (GDD §4.6), so it is the one tap that must not be replayed into a game
    // the player has not seen — a background tab stops polling (§7.3), and its
    // "Offer draw" button can outlive the game it was drawn for. A body that
    // omits `gameNumber` is not making that claim and is judged as before.
    if (gameNumber !== undefined && gameNumber !== room.gameNumber) {
      throw new ApiFailure(409, REFUSAL.differentGame);
    }

    if (room.game.result !== null) throw new ApiFailure(409, REFUSAL.gameOver);

    // What the tap was for, settled here rather than on the client: an offer
    // from the opponent can land *inside* this request, and then the same body
    // means "offer" to the player who sent it and "accept" to the server. The
    // player who did not accept anything must not end the game (GDD §4.6), and
    // a player who meant to accept must not silently offer instead.
    const standing = room.drawOffer[opponentOf(seat)];
    if (accepting !== undefined && accepting !== standing) {
      throw new ApiFailure(409, REFUSAL.differentOffer);
    }

    // Idempotent: offering twice is not accepting your own offer.
    if (room.drawOffer[seat]) return null;

    const drawOffer =
      seat === 'W'
        ? { ...room.drawOffer, W: true }
        : { ...room.drawOffer, B: true };
    if (!drawOffer.W || !drawOffer.B) return { ...room, drawOffer };

    return {
      ...room,
      game: agreeDraw(room.game),
      drawOffer: { W: false, B: false },
    };
  });
}
