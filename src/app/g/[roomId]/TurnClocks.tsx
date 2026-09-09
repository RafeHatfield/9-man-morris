/**
 * The per-turn countdown (GDD §5.3), for both players.
 *
 * Only the player on the clock is counting down; the other side shows the full
 * turn allowance it will get, because the clock resets every move. Below ten
 * seconds the running one goes red — and also gains a "left" suffix, since
 * colour is never the only signal (§6.5).
 *
 * Drawn only when the room says `clockRunning`: until both seats are filled the
 * room's `turnStartedAt` is a placeholder and nothing is actually ticking.
 */

import { PieceIcon } from '@/components/Piece';
import { PLAYER_NAME } from '@/components/boardModel';
import { formatClock, isUrgent } from '@/lib/client/clock';
import type { GameState, Player } from '@/lib/engine';

const SIDES: readonly Player[] = ['W', 'B'];

export interface TurnClocksProps {
  game: GameState;
  /** The room's per-turn allowance. */
  timerMs: number;
  /** What is left of the active player's turn; negative once it has run out. */
  remaining: number;
}

export function TurnClocks({ game, timerMs, remaining }: TurnClocksProps) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5 tabular-nums">
      {SIDES.map((player) => {
        const active = game.turn === player && game.result === null;
        const ms = active ? remaining : timerMs;
        const urgent = active && isUrgent(ms);
        return (
          <p
            key={player}
            data-testid={`clock-${player}`}
            data-active={active || undefined}
            data-urgent={urgent || undefined}
            className={`flex items-center gap-1 text-sm ${
              active ? 'font-semibold' : 'text-black/50'
            } ${urgent ? 'text-[#b3261e]' : ''}`}
          >
            <PieceIcon player={player} size={12} />
            <span className="sr-only">{PLAYER_NAME[player]}: </span>
            {formatClock(ms)}
            {urgent && <span className="sr-only"> left</span>}
          </p>
        );
      })}
    </div>
  );
}
