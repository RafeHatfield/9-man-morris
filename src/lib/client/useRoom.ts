'use client';

/**
 * Reading a room, and keeping it read (GDD §7.3).
 *
 * The client never trusts its own state: this hook holds whatever the server
 * last said and hands `adopt` to the callers who get a fresher answer out of a
 * mutation — including the body of a 409, which is a resync as much as a
 * refusal. Polling is the fallback for the moves this client did not make.
 */

import { useCallback, useEffect, useState } from 'react';
import { REFUSAL } from '@/lib/api/refusals';
import { fetchRoom } from './api';
import { pollIntervalMs } from './polling';
import {
  INITIAL_ROOM_STATE,
  adoptRoom,
  roomMissing,
  type RoomState,
} from './roomState';
import { SingleFlight } from './singleFlight';
import type { PublicRoom } from '@/lib/api/types';

export type { RoomStatus } from './roomState';

export interface RoomView extends RoomState {
  /** Take the server's word for it, unless this is an older word than we have. */
  adopt: (room: PublicRoom) => void;
  /** Read the room now, whatever the poll timer is doing. */
  refresh: () => Promise<void>;
}

/**
 * @param isYourTurn asked of whatever room the hook is holding, because the poll
 *                   interval depends on it (§7.3) and only the caller knows
 *                   which seat this client sits in.
 */
export function useRoom(
  roomId: string,
  isYourTurn: (room: PublicRoom) => boolean,
): RoomView {
  const [state, setState] = useState<RoomState>(INITIAL_ROOM_STATE);
  const [hidden, setHidden] = useState(false);
  /** A slow poll must not stack up behind itself. */
  const [gate] = useState(() => new SingleFlight());

  const adopt = useCallback((next: PublicRoom) => {
    const at = Date.now();
    setState((prev) => adoptRoom(prev, next, at));
  }, []);

  const refresh = useCallback(
    () =>
      gate.run(async () => {
        const result = await fetchRoom(roomId);
        if (result.ok) adopt(result.data);
        // A 404 on the *read*, in this server's own words, is the only thing
        // that says the room is gone — and it is terminal, since polling stops.
        // Two things are deliberately not enough on their own: a 404 from a
        // mutation (the room may be there and the request merely unlucky), and
        // a 404 whose body says anything else, which is an intermediary — an
        // edge, a proxy, a redeploy — answering for a room that still exists.
        else if (
          result.status === 404 &&
          result.error === REFUSAL.roomNotFound
        ) {
          setState(roomMissing);
        }
        // Anything else (a network blip, a 500) leaves the last known room on
        // screen; the next poll tries again.
      }),
    [roomId, adopt, gate],
  );

  // First read.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // §7.3: stop while the tab is hidden, resume — and re-read at once — on focus.
  useEffect(() => {
    function onVisibility() {
      const nowHidden = document.visibilityState === 'hidden';
      setHidden(nowHidden);
      if (!nowHidden) void refresh();
    }
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refresh]);

  const interval = pollIntervalMs({
    hidden,
    missing: state.status === 'missing',
    live: state.room !== null && state.room.game.result === null,
    yourTurn: state.room !== null && isYourTurn(state.room),
  });

  useEffect(() => {
    if (interval === null) return;
    const id = setInterval(() => void refresh(), interval);
    return () => clearInterval(id);
  }, [interval, refresh]);

  return { ...state, adopt, refresh };
}
