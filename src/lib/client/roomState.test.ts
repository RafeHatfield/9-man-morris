import { describe, expect, it } from 'vitest';

import type { PublicRoom } from '@/lib/api/types';
import { initialState } from '@/lib/engine';
import {
  INITIAL_ROOM_STATE,
  adoptRoom,
  roomMissing,
  type RoomState,
} from './roomState';

function room(version: number, serverNow = 1_000): PublicRoom {
  return {
    id: 'ROOM1234',
    version,
    game: initialState(),
    timerMs: 300_000,
    turnStartedAt: 0,
    serverNow,
    seats: { W: true, B: true },
    clockRunning: true,
    rematch: { W: false, B: false },
    drawOffer: { W: false, B: false },
    gameNumber: 1,
  };
}

const ready = (version: number): RoomState => ({
  room: room(version),
  status: 'ready',
  skewMs: 0,
});

describe('adoptRoom', () => {
  it('takes the first room it is given', () => {
    const next = adoptRoom(INITIAL_ROOM_STATE, room(1), 900);
    expect(next.status).toBe('ready');
    expect(next.room?.version).toBe(1);
  });

  it('measures the clock skew from the response', () => {
    expect(adoptRoom(INITIAL_ROOM_STATE, room(1, 1_000), 900).skewMs).toBe(100);
    expect(adoptRoom(INITIAL_ROOM_STATE, room(1, 1_000), 1_250).skewMs).toBe(-250);
  });

  it('adopts a newer room', () => {
    expect(adoptRoom(ready(4), room(5), 0).room?.version).toBe(5);
  });

  it('drops an older room — a poll must not undo a mutation', () => {
    const prev = ready(5);
    expect(adoptRoom(prev, room(4), 0)).toBe(prev);
  });

  it('adopts the same version again, to re-measure the clock', () => {
    const next = adoptRoom(ready(5), room(5, 2_000), 1_000);
    expect(next.room?.version).toBe(5);
    expect(next.skewMs).toBe(1_000);
  });
});

describe('roomMissing', () => {
  it('marks the room gone, and keeps the room it had', () => {
    const next = roomMissing(ready(3));
    expect(next.status).toBe('missing');
    expect(next.room?.version).toBe(3);
  });

  it('is idempotent', () => {
    const gone = roomMissing(ready(3));
    expect(roomMissing(gone)).toBe(gone);
  });
});
