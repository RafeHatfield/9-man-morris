/**
 * The finished-game banner (GDD §6.3): the result and the reason, plus the two
 * things left to do — a rematch (§5.4) and a new game (§5.1).
 *
 * The colour and the reason are `chromeModel.statusHeadline`, the same sentence
 * the status bar shows, so the vocabulary for a reason is written once. What
 * this adds is the half the chrome cannot know: which of the two players is
 * reading it. A read-only visitor (§6.4) gets the result and no controls.
 */

import Link from 'next/link';
import { statusHeadline } from '@/components/chromeModel';
import { PLAYER_NAME } from '@/components/boardModel';
import { opponentOf, type GameState, type Player } from '@/lib/engine';
import { BUTTON_CLASS } from './ui';

export interface GameOverBannerProps {
  state: GameState;
  /** The viewer's colour, or `null` for a spectator. */
  you: Player | null;
  rematch: { W: boolean; B: boolean };
  busy: boolean;
  onRematch: () => void;
}

export function GameOverBanner({
  state,
  you,
  rematch,
  busy,
  onRematch,
}: GameOverBannerProps) {
  const result = state.result;
  if (result === null) return null;

  const offeredByThem = you !== null && rematch[opponentOf(you)];
  const offeredByYou = you !== null && rematch[you];

  return (
    <section
      role="status"
      data-testid="game-over"
      className="flex flex-col gap-2 rounded-xl border border-black/20 bg-white px-3 py-2"
    >
      <div>
        <p className="text-base font-semibold" data-testid="result-winner">
          {outcome(result.winner, you)}
        </p>
        <p className="mt-0.5 text-xs text-black/60" data-testid="result-reason">
          {statusHeadline(state)}
        </p>
      </div>
      {you !== null && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRematch}
            disabled={busy || offeredByYou}
            data-testid="rematch"
            className={BUTTON_CLASS}
          >
            {offeredByThem
              ? 'Accept rematch'
              : offeredByYou
                ? 'Rematch offered'
                : 'Rematch'}
          </button>
          <Link href="/" data-testid="new-game-link" className={BUTTON_CLASS}>
            New game
          </Link>
        </div>
      )}
    </section>
  );
}

function outcome(winner: Player | null, you: Player | null): string {
  if (winner === null) return 'A draw.';
  if (you === null) return `${PLAYER_NAME[winner]} wins.`;
  return winner === you ? 'You win.' : 'You lose.';
}
