'use client';

/**
 * The front door (GDD §5.1): pick a turn timer, tap **New game**, and land on
 * the room. The token the server issues is stored before the navigation, so the
 * room page finds the creator already seated as White.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BOARD_MARGIN_PX, PAGE_MAX_PX } from '@/components/geometry';
import { DEFAULT_TIMER_MS, TIMER_CHOICES } from '@/lib/api/types';
import { createGame } from '@/lib/client/api';
import { timerLabel } from '@/lib/client/clock';
import { storageAvailable, writeSeat } from '@/lib/client/seat';

const BUTTON_CLASS =
  'flex min-h-11 items-center justify-center rounded-xl border border-black/20 bg-white px-5 text-sm font-semibold active:bg-black/5';

export default function Home() {
  const router = useRouter();
  const [timerMs, setTimerMs] = useState<number | null>(DEFAULT_TIMER_MS);
  const [busy, setBusy] = useState(false);
  /**
   * A seat lives in `localStorage` (§9), so a browser that will not store one
   * cannot hold a seat: creating a room would leave the creator spectating their
   * own game. Probed on the tap rather than on mount — it cannot change while
   * the page is open, and asking at the moment it matters keeps the server
   * render and the first client render identical.
   */
  const [canHoldSeat, setCanHoldSeat] = useState(true);

  async function newGame() {
    if (busy) return;
    if (!storageAvailable()) {
      setCanHoldSeat(false);
      return;
    }
    setBusy(true);
    const created = await createGame(timerMs);
    if (!created.ok) {
      // Nothing to say and nowhere to say it (§6.2): the button comes back.
      setBusy(false);
      return;
    }
    // The probe above writes one byte and removes it, which a store with a
    // little room left will allow; this is the write that has to land. A seat
    // that will not survive a refresh is worse than none (§5.1), and navigating
    // on one would leave White's seat held by a tab that cannot come back to it
    // and the room unplayable by anyone else.
    if (
      !writeSeat(created.data.roomId, {
        token: created.data.token,
        colour: created.data.colour,
        gameNumber: created.data.room.gameNumber,
      })
    ) {
      setCanHoldSeat(false);
      setBusy(false);
      return;
    }
    router.push(`/g/${created.data.roomId}`);
  }

  return (
    <main
      className="mx-auto flex min-h-dvh w-full flex-col items-center justify-center gap-6"
      style={{ maxWidth: PAGE_MAX_PX, padding: BOARD_MARGIN_PX }}
    >
      <h1 className="text-2xl font-semibold">Morris</h1>

      <fieldset className="w-full max-w-xs">
        <legend className="mb-2 text-center text-sm text-black/60">
          Turn timer
        </legend>
        <div className="grid grid-cols-2 gap-2" data-testid="timer-choices">
          {TIMER_CHOICES.map((choice) => {
            const checked = choice === timerMs;
            return (
              <label
                key={String(choice)}
                data-testid={`timer-${choice ?? 'none'}`}
                data-checked={checked || undefined}
                className={`flex min-h-11 cursor-pointer items-center justify-center rounded-xl border px-3 text-sm font-semibold ${
                  checked
                    ? 'border-black/50 bg-white ring-2 ring-black/40'
                    : 'border-black/20 bg-white/60'
                }`}
              >
                <input
                  type="radio"
                  name="timer"
                  className="sr-only"
                  checked={checked}
                  onChange={() => setTimerMs(choice)}
                />
                {timerLabel(choice)}
              </label>
            );
          })}
        </div>
      </fieldset>

      <button
        type="button"
        onClick={() => void newGame()}
        disabled={busy}
        data-testid="new-game"
        className={`${BUTTON_CLASS} w-full max-w-xs disabled:opacity-50`}
      >
        New game
      </button>

      {!canHoldSeat && (
        <p
          className="max-w-xs text-center text-xs text-black/60"
          data-testid="no-seat-storage"
        >
          A seat could not be saved in this browser, so it cannot be held. You
          can still open a shared link as a spectator, or play hot-seat.
        </p>
      )}

      <Link href="/local" className={BUTTON_CLASS}>
        Play hot-seat
      </Link>
    </main>
  );
}
