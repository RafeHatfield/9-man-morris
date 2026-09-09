/**
 * Top chrome (GDD §6.1): whose turn, phase, the pending-removal prompt, and a
 * slot on the right for timers (§5.3, wired by the online mode). The wording is
 * `chromeModel.ts`; this file is layout.
 */

import type { ReactNode } from 'react';
import type { GameState, Player } from '@/lib/engine';
import { PieceIcon } from './Piece';
import { statusDetail, statusHeadline } from './chromeModel';

export interface StatusBarProps {
  state: GameState;
  /** The viewer's colour. Omit for hot-seat (both seats are the viewer). */
  you?: Player | null;
  /** Read-only visitor (§6.4). */
  spectating?: boolean;
  /** The room is still waiting for its second player, so nobody may move. */
  waiting?: boolean;
  /** Timer slot. */
  children?: ReactNode;
}

export function StatusBar({
  state,
  you,
  spectating,
  waiting,
  children,
}: StatusBarProps) {
  return (
    <header className="flex items-center gap-3 rounded-xl border border-black/10 bg-white/70 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-base font-semibold">
          {state.result === null && <PieceIcon player={state.turn} />}
          <span className="truncate" data-testid="status-headline">
            {statusHeadline(state, you, waiting)}
          </span>
        </p>
        {/* Wraps rather than truncates. The longest line this produces —
            "Mill! White removes a Black piece. · Spectating" — overflows a
            360 px row by 22 px once the timers are beside it, and an ellipsis
            there would hide either what a spectator is being told to expect or
            the fact that they have no seat. The headline above stays truncated:
            its longest string is "White wins — mill-out", which fits. */}
        <p className="mt-0.5 text-xs text-black/60" data-testid="status-detail">
          {statusDetail(state, spectating)}
        </p>
      </div>
      {children}
    </header>
  );
}
