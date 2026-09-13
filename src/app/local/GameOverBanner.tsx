/**
 * The finished-game banner (GDD §6.3): the result and the reason, plus the one
 * thing there is left to do — a rematch (§5.2, §5.4).
 *
 * The colour and the reason come from `chromeModel.statusHeadline`, the same
 * function the status bar uses, so the board's vocabulary for a reason
 * ("mill-out", "blocked", "forfeit", "resignation", "50-move rule", "agreed") is
 * written once. What this file adds is the line the chrome cannot know — *which
 * of the two people at the device* that colour is — and it leads with it, since
 * the status bar is already showing the other half.
 */

import type { GameState } from '@/lib/engine';
import { statusHeadline } from '@/components/chromeModel';
import { SEAT_NAME, seatOf } from './seats';

export interface GameOverBannerProps {
  state: GameState;
  gameNumber: number;
  onRematch: () => void;
}

export function GameOverBanner({
  state,
  gameNumber,
  onRematch,
}: GameOverBannerProps) {
  const result = state.result;
  if (result === null) return null;

  const winnerSeat =
    result.winner === null ? null : seatOf(result.winner, gameNumber);

  return (
    <section
      role="status"
      data-testid="game-over"
      className="flex items-center gap-3 rounded-xl border border-black/20 bg-white px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        {/* Who won, in the terms the two people at the device use... */}
        <p className="text-base font-semibold" data-testid="result-winner">
          {winnerSeat === null ? 'A draw.' : `${SEAT_NAME[winnerSeat]} wins.`}
        </p>
        {/* ...and the colour and the reason, in the board's own words (§6.3). */}
        <p className="mt-0.5 text-xs text-black/60" data-testid="result-reason">
          {statusHeadline(state)}
        </p>
      </div>
      <button
        type="button"
        onClick={onRematch}
        data-testid="rematch"
        className="min-h-11 shrink-0 rounded-xl border border-black/20 bg-white px-4 text-sm font-semibold active:bg-black/5"
      >
        Rematch
      </button>
    </section>
  );
}
