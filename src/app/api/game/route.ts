/**
 * `POST /api/game` — creates a room (GDD §7.3). The creator is White in game 1
 * and gets the only token issued here; Black's is issued by `/join`.
 */

import {
  DEFAULT_TIMER_MS,
  apiStore,
  guarded,
  createGameSchema,
  jsonResponse,
  parseBody,
  publicRoom,
} from '@/lib/api';
import type { CreateGameResponse } from '@/lib/api';
import { initialState } from '@/lib/engine';
import { newPlayerToken, newRoomId } from '@/lib/store';
import type { Room } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = await parseBody(request, createGameSchema);
  if (!body.ok) return body.response;

  return guarded(() => createRoom(body.value.timerMs));
}

async function createRoom(chosenTimer: number | null | undefined): Promise<Response> {
  const now = Date.now();
  const token = newPlayerToken();
  // `undefined` is "not chosen" and takes the default; `null` is the "None" choice.
  const timerMs = chosenTimer === undefined ? DEFAULT_TIMER_MS : chosenTimer;

  const room: Room = {
    id: newRoomId(),
    version: 1,
    createdAt: now,
    players: { W: token, B: null },
    timerMs,
    turnStartedAt: now,
    game: initialState(),
    rematch: { W: false, B: false },
    drawOffer: { W: false, B: false },
    gameNumber: 1,
  };
  await apiStore().set(room.id, room);

  const response: CreateGameResponse = {
    roomId: room.id,
    token,
    colour: 'W',
    room: publicRoom(room, now),
  };
  return jsonResponse(200, response);
}
