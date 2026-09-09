/**
 * Bottom chrome (GDD §6.1): pieces in hand and on the board per side, plus a
 * slot for buttons (resign, offer draw, share, rematch) filled by each mode.
 */

import type { ReactNode } from 'react';
import type { GameState, Player } from '@/lib/engine';
import { PieceIcon } from './Piece';
import { PLAYER_NAME } from './boardModel';
import { pieceCounts } from './chromeModel';

export interface BottomBarProps {
  state: GameState;
  /** Button slot. */
  children?: ReactNode;
}

export function BottomBar({ state, children }: BottomBarProps) {
  return (
    <footer className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <SideCount state={state} player="W" />
        <SideCount state={state} player="B" />
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </footer>
  );
}

function SideCount({ state, player }: { state: GameState; player: Player }) {
  const { hand, onBoard } = pieceCounts(state, player);
  const turn = state.result === null && state.turn === player;
  return (
    <div
      data-testid={`count-${player}`}
      className={`rounded-xl border px-3 py-2 ${
        turn ? 'border-black/40 bg-white' : 'border-black/10 bg-white/60'
      }`}
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <PieceIcon player={player} />
        {PLAYER_NAME[player]}
      </p>
      <p className="mt-0.5 text-xs text-black/60">
        <span data-testid={`hand-${player}`}>{hand}</span> in hand ·{' '}
        <span data-testid={`board-${player}`}>{onBoard}</span> on board
      </p>
    </div>
  );
}
