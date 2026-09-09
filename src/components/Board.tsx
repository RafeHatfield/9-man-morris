'use client';

/**
 * The board (GDD §6.2–6.3). JSX over `boardModel.ts` and nothing else: it renders
 * a `GameState` and reports taps. It holds no rules — whether a point can be
 * tapped is answered by the `legal` list it is handed, and every tap that is not
 * in that list is reported anyway and silently ignored by the caller.
 *
 * With no `onPointTap`, or an empty `legal` list, the board is inert: that is the
 * spectator view (§6.4), the not-your-turn view (§6.2) and the finished game.
 */

import { useMemo } from 'react';
import type { Action, GameState } from '@/lib/engine';
import { PieceShape } from './Piece';
import {
  boardIsActive,
  buildMarks,
  flashingMill,
  pointLabel,
} from './boardModel';
import {
  BOARD_MAX_PX,
  POINT_XY,
  SEGMENTS,
  TAP_SHAPE_CLASS,
  TAP_SIZE,
  VIEWBOX,
} from './geometry';

const COLOUR = {
  plate: '#e8dcc8',
  line: '#8a7a5f',
  hint: '#1f7a5a',
  select: '#1b4fd8',
  take: '#b3261e',
  last: '#d9a441',
} as const;

const PIECE_R = 5.4;
const HINT_R = 4.2;
const SELECT_R = 6.4;
const TAKE_R = 6.8;
const LAST_SIZE = 12;

export interface BoardProps {
  state: GameState;
  /**
   * The viewer's legal actions, from `legalActions(state)` — or `[]` when the
   * board should be inert (not your turn, spectating, game over).
   */
  legal?: readonly Action[];
  /** The currently selected own piece, in the movement phase. */
  selected?: number | null;
  /** Omit for a read-only board. */
  onPointTap?: (point: number) => void;
}

export function Board({
  state,
  legal = [],
  selected = null,
  onPointTap,
}: BoardProps) {
  const active = boardIsActive(legal, onPointTap !== undefined);

  const marks = useMemo(
    () => buildMarks(state, legal, selected),
    [state, legal, selected],
  );

  // The pieces of a mill flash once when it is formed (§6.3). Keying the group on
  // the move that made it restarts the CSS animation exactly once.
  const flash = useMemo(() => flashingMill(state), [state]);

  return (
    // The cap comes from `geometry.ts`, which is also what the §6.2 hit-target
    // test measures — see BOARD_MAX_PX.
    <div
      className="relative mx-auto aspect-square w-full"
      style={{ maxWidth: BOARD_MAX_PX }}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <rect
          x="0.5"
          y="0.5"
          width={VIEWBOX - 1}
          height={VIEWBOX - 1}
          rx="3"
          fill={COLOUR.plate}
          stroke={COLOUR.line}
          strokeOpacity="0.35"
          strokeWidth="0.6"
        />

        {SEGMENTS.map((seg, i) => (
          <line
            key={i}
            x1={seg.a.x}
            y1={seg.a.y}
            x2={seg.b.x}
            y2={seg.b.y}
            stroke={COLOUR.line}
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        ))}

        {/* Last move: a soft square behind the two points it touched (§6.3). */}
        {marks.map((m, i) =>
          m.lastFrom || m.lastTo ? (
            <rect
              key={`last-${i}`}
              x={POINT_XY[i].x - LAST_SIZE / 2}
              y={POINT_XY[i].y - LAST_SIZE / 2}
              width={LAST_SIZE}
              height={LAST_SIZE}
              rx="2"
              fill={COLOUR.last}
              fillOpacity={m.lastTo ? 0.45 : 0.28}
              stroke={COLOUR.last}
              strokeWidth="0.7"
              strokeDasharray={m.lastFrom ? '2 1.6' : undefined}
            />
          ) : null,
        )}

        {marks.map((m, i) =>
          m.occupant === null ? (
            <circle
              key={`dot-${i}`}
              cx={POINT_XY[i].x}
              cy={POINT_XY[i].y}
              r="1.7"
              fill={COLOUR.line}
              fillOpacity="0.5"
            />
          ) : (
            <g
              key={`piece-${i}`}
              transform={`translate(${POINT_XY[i].x} ${POINT_XY[i].y})`}
              opacity={m.dimmed ? 0.35 : 1}
            >
              <PieceShape player={m.occupant} r={PIECE_R} />
            </g>
          ),
        )}

        {/* Legal placement / destination hint: a dashed outline, not a colour. */}
        {marks.map((m, i) =>
          m.hint ? (
            <circle
              key={`hint-${i}`}
              cx={POINT_XY[i].x}
              cy={POINT_XY[i].y}
              r={HINT_R}
              fill="none"
              stroke={COLOUR.hint}
              strokeWidth="1.2"
              strokeDasharray="2.2 1.8"
            />
          ) : null,
        )}

        {/* Selected piece: a double outline ring. */}
        {marks.map((m, i) =>
          m.selected ? (
            <g key={`sel-${i}`}>
              <circle
                cx={POINT_XY[i].x}
                cy={POINT_XY[i].y}
                r={SELECT_R}
                fill="none"
                stroke={COLOUR.select}
                strokeWidth="1.4"
              />
              <circle
                cx={POINT_XY[i].x}
                cy={POINT_XY[i].y}
                r={SELECT_R - 2.1}
                fill="none"
                stroke={COLOUR.select}
                strokeWidth="0.7"
              />
            </g>
          ) : null,
        )}

        {/* Removable opponent pieces pulse; protected ones are dimmed above. */}
        {marks.map((m, i) =>
          m.removable ? (
            <circle
              key={`take-${i}`}
              className="morris-pulse"
              cx={POINT_XY[i].x}
              cy={POINT_XY[i].y}
              r={TAKE_R}
              fill="none"
              stroke={COLOUR.take}
              strokeWidth="1.6"
              strokeDasharray="3 2"
            />
          ) : null,
        )}

        {flash !== null && (
          <g key={flash.key} className="morris-flash" opacity="0">
            {flash.points.map((p) => (
              <circle
                key={p}
                cx={POINT_XY[p].x}
                cy={POINT_XY[p].y}
                r={PIECE_R + 1.6}
                fill="none"
                stroke={COLOUR.last}
                strokeWidth="2.2"
              />
            ))}
          </g>
        )}
      </svg>

      {/* Real buttons on top of the picture (§6.5). Each is a square one lattice
          step on a side — 45.92 px of clickable area at a 360 px viewport. The
          shape comes from `geometry.ts`, which explains why it must not be
          rounded: a browser hit-tests a rounded button by its rounded shape. */}
      {marks.map((m, i) => (
        <button
          key={`tap-${i}`}
          type="button"
          disabled={!active}
          onClick={onPointTap ? () => onPointTap(i) : undefined}
          aria-label={pointLabel(i, m.occupant)}
          aria-pressed={m.selectable ? m.selected : undefined}
          data-point={i}
          data-occupant={m.occupant ?? 'empty'}
          data-hint={m.hint || undefined}
          data-removable={m.removable || undefined}
          className={`absolute -translate-x-1/2 -translate-y-1/2 touch-manipulation ${TAP_SHAPE_CLASS} focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[#1b4fd8] disabled:cursor-default`}
          style={{
            left: `${POINT_XY[i].x}%`,
            top: `${POINT_XY[i].y}%`,
            width: `${TAP_SIZE}%`,
            height: `${TAP_SIZE}%`,
          }}
        />
      ))}
    </div>
  );
}
