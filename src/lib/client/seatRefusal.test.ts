import { describe, expect, it } from 'vitest';

import { REFUSAL } from '@/lib/api/refusals';
import type { PublicRoom } from '@/lib/api/types';
import { initialState, type Player } from '@/lib/engine';
import type { ApiResult } from './api';
import type { StoredSeat } from './seat';
import { seatIsRefused } from './seatRefusal';

function room(turn: Player, gameNumber = 1): PublicRoom {
  return {
    id: 'ROOM1234',
    version: 7,
    game: { ...initialState(), turn },
    timerMs: 60_000,
    turnStartedAt: 0,
    serverNow: 0,
    seats: { W: true, B: true },
    clockRunning: true,
    rematch: { W: false, B: false },
    drawOffer: { W: false, B: false },
    gameNumber,
  };
}

/** The refusal that means it: `mutateRoom`'s answer when the token has no seat. */
const refused = (room: PublicRoom): ApiResult<PublicRoom> => ({
  ok: false,
  status: 403,
  error: REFUSAL.notAPlayer,
  room,
});

/** Issued as White in game 1. A rematch makes the same token Black in game 2. */
const SEAT: StoredSeat = { token: 't', colour: 'W', gameNumber: 1 };

describe('seatIsRefused', () => {
  it('is a 403 with a room, and nothing else', () => {
    expect(seatIsRefused(refused(room('W')), SEAT)).toBe(true);
    expect(seatIsRefused({ ok: true, data: room('W') }, SEAT)).toBe(false);
    expect(
      seatIsRefused(
        { ok: false, status: 409, error: 'stale', room: room('W') },
        SEAT,
      ),
    ).toBe(false);
    expect(
      seatIsRefused({ ok: false, status: 404, error: 'gone' }, SEAT),
    ).toBe(false);
    // The sentence with no room did not arrive in this server's envelope, and a
    // seat is not deleted on something this client cannot attribute.
    expect(
      seatIsRefused({ ok: false, status: 403, error: REFUSAL.notAPlayer }, SEAT),
    ).toBe(false);
    // The sentence on the wrong status is not this refusal either: `mutateRoom`
    // answers `notAPlayer` with 403 and nothing else, so the same words under a
    // 409 came from something that is not this server answering this question.
    expect(
      seatIsRefused(
        {
          ok: false,
          status: 409,
          error: REFUSAL.notAPlayer,
          room: room('W'),
        },
        SEAT,
      ),
    ).toBe(false);
  });

  it('has nothing to give up when there is no seat', () => {
    expect(seatIsRefused(refused(room('W')), null)).toBe(false);
  });

  it('gives the seat up for one 403 only: the one that says it is not a seat', () => {
    // The API's other three route-level 403s, each earned by a token that
    // really does hold a seat. Reading any of them as seat loss deletes a token
    // §5.1 cannot give back — and no property of the *request* rules all three
    // out: `/action` refuses `{type: 'forfeit'}` ahead of the turn check, so on
    // our own turn it is indistinguishable from "not your seat" by anything but
    // the sentence.
    for (const error of [
      REFUSAL.notYourTurn,
      REFUSAL.forfeitIsServerIssued,
      REFUSAL.yourOwnClock,
    ]) {
      const other: ApiResult<PublicRoom> = {
        ok: false,
        status: 403,
        error,
        room: room('W'),
      };
      expect(seatIsRefused(other, SEAT)).toBe(false);
    }

    // And the one that does mean it means it in every room — whatever the turn
    // is, and whichever game the refusal came from. A rematch swaps the colours
    // attached to the two tokens (§5.4); it never unseats either, so nothing
    // about the room can soften this sentence.
    for (const carried of [room('W'), room('B'), room('W', 2), room('B', 2)]) {
      expect(seatIsRefused(refused(carried), SEAT)).toBe(true);
    }
  });
});
