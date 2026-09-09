/**
 * What a tap on a point means (GDD §6.2). This is not rules logic: it only looks
 * up the point in the `legalActions()` list it was handed. Anything not in that
 * list is silently ignored.
 */

import type { Action } from '@/lib/engine';

export type TapOutcome =
  | { kind: 'action'; action: Action }
  | { kind: 'select'; point: number }
  | { kind: 'deselect' }
  | { kind: 'ignore' };

/**
 * @param legal    the engine's legal actions for the player to move, or `[]`
 *                 when the board is inert (not your turn, spectating, game over)
 * @param selected the currently selected own piece, if any
 * @param point    the point that was tapped
 */
export function interpretTap(
  legal: readonly Action[],
  selected: number | null,
  point: number,
): TapOutcome {
  const removal = legal.find((a) => a.type === 'remove' && a.point === point);
  if (removal) return { kind: 'action', action: removal };

  const placement = legal.find((a) => a.type === 'place' && a.point === point);
  if (placement) return { kind: 'action', action: placement };

  if (selected !== null) {
    // Tapping the selected piece again deselects it.
    if (point === selected) return { kind: 'deselect' };
    const move = legal.find(
      (a) => a.type === 'move' && a.from === selected && a.to === point,
    );
    if (move) return { kind: 'action', action: move };
  }

  // Tapping a piece that has somewhere to go selects it (or swaps the selection).
  if (legal.some((a) => a.type === 'move' && a.from === point)) {
    return { kind: 'select', point };
  }

  // Tapping anywhere else drops the selection, and otherwise does nothing.
  return selected !== null ? { kind: 'deselect' } : { kind: 'ignore' };
}
