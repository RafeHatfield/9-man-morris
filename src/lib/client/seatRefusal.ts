/**
 * Whether a refusal proves this device has lost its seat (GDD §6.4, §7.3).
 *
 * The client cannot ask whether its token holds a seat — `PublicRoom` carries no
 * tokens and every token-bearing endpoint mutates — so the only evidence is a
 * refusal, and exactly one refusal is that evidence: `REFUSAL.notAPlayer`.
 * `mutateRoom` answers it when `seatOf` finds no seat for the token, ahead of
 * the version, the turn, the clock and the action, about the very room it hands
 * back in the same response. There is no state in which a token that genuinely
 * holds a seat earns that sentence — a rematch swaps which colour each token
 * holds (§5.4); it never unseats either.
 *
 * The API's three other route-level 403s are all earned by tokens that do hold a
 * seat — `notYourTurn`; `forfeitIsServerIssued`, which `/action` refuses ahead
 * of the turn check; and `yourOwnClock` from `/claim-timeout` — so none of them
 * is read as seat loss, and neither is any 403 the API grows next.
 *
 * That is the whole decision, and it is the server's, not this client's. Getting
 * it wrong deletes a real player's token and, per §5.1, that seat cannot be
 * recovered.
 */

import { REFUSAL } from '@/lib/api/refusals';
import type { PublicRoom } from '@/lib/api/types';
import type { ApiResult } from './api';
import type { StoredSeat } from './seat';

/** The whole decision, given the result of one request. */
export function seatIsRefused(
  result: ApiResult<PublicRoom>,
  seat: StoredSeat | null,
): boolean {
  if (result.ok || result.status !== 403) return false;
  // Nothing below needs the room. What its presence says is that the refusal is
  // this server's: `send` keeps a room only when it is a room and it is *this*
  // room, and every genuine `notAPlayer` carries one. A bare 403 in the right
  // words from something in the way is not enough to delete a seat over.
  if (result.room === undefined) return false;
  if (result.error !== REFUSAL.notAPlayer) return false;
  return seat !== null;
}
