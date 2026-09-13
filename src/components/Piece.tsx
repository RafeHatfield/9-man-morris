/**
 * The one place a piece is drawn. GDD §6.5: the two players differ in fill *and*
 * an inner mark, so colour is never the only signal — White is a light disc with
 * a ring, Black is a dark disc with a diamond.
 */

import type { Player } from '@/lib/engine';

export const PIECE_COLOURS = {
  W: { fill: '#fdfbf7', stroke: '#2a2622', mark: '#2a2622' },
  B: { fill: '#2a2622', stroke: '#12100e', mark: '#e8dcc8' },
} as const;

/** SVG contents of a piece centred on (0, 0) with radius `r`. */
export function PieceShape({ player, r }: { player: Player; r: number }) {
  const c = PIECE_COLOURS[player];
  return (
    <>
      <circle r={r} fill={c.fill} stroke={c.stroke} strokeWidth={r * 0.14} />
      {player === 'W' ? (
        <circle
          r={r * 0.44}
          fill="none"
          stroke={c.mark}
          strokeWidth={r * 0.13}
        />
      ) : (
        <path
          d={`M0 ${-r * 0.46}L${r * 0.46} 0L0 ${r * 0.46}L${-r * 0.46} 0Z`}
          fill={c.mark}
        />
      )}
    </>
  );
}

/** A standalone piece icon for the chrome (status bar, bottom bar). */
export function PieceIcon({
  player,
  size = 16,
}: {
  player: Player;
  size?: number;
}) {
  return (
    <svg
      viewBox="-10 -10 20 20"
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0"
    >
      <PieceShape player={player} r={9} />
    </svg>
  );
}
