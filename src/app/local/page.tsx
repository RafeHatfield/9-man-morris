'use client';

/**
 * Hot-seat (GDD §5.2): two players, one device, no server and no polling. The
 * same engine and the same board as online — the only difference is that the
 * player to move is always the person holding the phone.
 *
 * There is therefore no seat to authenticate and nothing to wait for: every
 * action is applied as `state.turn`, and the two people are tracked only as
 * labels so that "rematch swaps colours" (§5.2) means something on one device.
 * The per-turn timer is optional here (§5.2) and is not built.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Board } from '@/components/Board';
import { BottomBar } from '@/components/BottomBar';
import { StatusBar } from '@/components/StatusBar';
import { PLAYER_NAME } from '@/components/boardModel';
import { BOARD_MARGIN_PX, PAGE_MAX_PX } from '@/components/geometry';
import { interpretTap } from '@/components/interaction';
import {
  agreeDraw,
  apply,
  initialState,
  legalActions,
  type GameState,
} from '@/lib/engine';
import { GameOverBanner } from './GameOverBanner';
import { SEATS, SEAT_NAME, colourOf } from './seats';

const BUTTON_CLASS =
  'flex min-h-11 grow items-center justify-center rounded-xl border border-black/20 bg-white px-3 text-sm font-semibold active:bg-black/5';

export default function LocalPage() {
  const [state, setState] = useState<GameState>(initialState);
  const [selected, setSelected] = useState<number | null>(null);
  /** 1-based, increments on rematch; its parity decides who is White (§7.4). */
  const [gameNumber, setGameNumber] = useState(1);

  const legal = useMemo(() => legalActions(state), [state]);
  const live = state.result === null;

  function handleTap(point: number) {
    const outcome = interpretTap(legal, selected, point);
    switch (outcome.kind) {
      case 'action':
        // Hot-seat: the player to move is whoever is holding the device.
        setState(apply(state, outcome.action, state.turn));
        setSelected(null);
        return;
      case 'select':
        setSelected(outcome.point);
        return;
      case 'deselect':
        setSelected(null);
        return;
      case 'ignore':
        // GDD §6.2: an illegal tap does nothing at all. No toast, no error.
        return;
    }
  }

  /** §5.2: a fresh game with the colours swapped. White still moves first. */
  function rematch() {
    setState(initialState());
    setSelected(null);
    setGameNumber((n) => n + 1);
  }

  /** §4.6: the player to move gives it up; the win goes to the opponent. */
  function resign() {
    setState(apply(state, { type: 'resign' }, state.turn));
    setSelected(null);
  }

  /** §4.6: both players are at the device, so one tap is the agreement. */
  function draw() {
    setState(agreeDraw(state));
    setSelected(null);
  }

  return (
    // §6.1 sizing comes from `geometry.ts`: this padding is the 16 px margin the
    // board's width — and so the 44 px hit-target arithmetic — is derived from.
    <main
      className="mx-auto flex min-h-dvh w-full flex-col gap-3"
      style={{ maxWidth: PAGE_MAX_PX, padding: BOARD_MARGIN_PX }}
    >
      <StatusBar state={state} />

      <GameOverBanner
        state={state}
        gameNumber={gameNumber}
        onRematch={rematch}
      />

      <Board
        state={state}
        legal={legal}
        selected={selected}
        onPointTap={handleTap}
      />

      <div className="flex-1" />

      <BottomBar state={state}>
        <p className="w-full text-xs text-black/60" data-testid="seats">
          {SEATS.map((seat, i) => (
            <span key={seat}>
              {i > 0 && ' · '}
              {SEAT_NAME[seat]} plays{' '}
              <span data-testid={`seat-${seat}`} className="font-semibold">
                {PLAYER_NAME[colourOf(seat, gameNumber)]}
              </span>
            </span>
          ))}
        </p>
        {live && (
          <button
            type="button"
            onClick={resign}
            data-testid="resign"
            className={BUTTON_CLASS}
          >
            Resign
          </button>
        )}
        {live && (
          <button
            type="button"
            onClick={draw}
            data-testid="draw"
            className={BUTTON_CLASS}
          >
            Agree draw
          </button>
        )}
        <Link href="/" className={BUTTON_CLASS}>
          Home
        </Link>
      </BottomBar>
    </main>
  );
}
