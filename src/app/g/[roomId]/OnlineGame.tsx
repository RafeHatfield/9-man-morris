'use client';

/**
 * Online play (GDD §5.1, §6.1). The whole page: seat resolution, polling, the
 * board, the clocks, and the four things a player can do out of turn (share,
 * resign, offer a draw, claim a win on time).
 *
 * The server is the only authority (§7.3). Every tap is sent with the version
 * the board was drawn from and the answer — a 200, or the room that comes back
 * with a refusal — is adopted verbatim. Nothing here decides what a move does,
 * nothing here holds an optimistic board, and a seat the server refuses is given
 * up rather than kept (see {@link SeatRefusal}).
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board } from '@/components/Board';
import { BottomBar } from '@/components/BottomBar';
import { StatusBar } from '@/components/StatusBar';
import { PLAYER_NAME } from '@/components/boardModel';
import { BOARD_MARGIN_PX, PAGE_MAX_PX } from '@/components/geometry';
import { interpretTap } from '@/components/interaction';
import type { PublicRoom } from '@/lib/api/types';
import {
  claimTimeout,
  joinRoom,
  offerDraw,
  offerRematch,
  resignGame,
  sendAction,
  type ApiResult,
} from '@/lib/client/api';
import { canClaim, remainingMs, serverNow } from '@/lib/client/clock';
import {
  clearSeat,
  colourFor,
  readSeat,
  storageAvailable,
  writeSeat,
  type StoredSeat,
} from '@/lib/client/seat';
import { seatIsRefused } from '@/lib/client/seatRefusal';
import { SingleFlight } from '@/lib/client/singleFlight';
import { useRoom } from '@/lib/client/useRoom';
import { legalActions, opponentOf } from '@/lib/engine';
import { GameOverBanner } from './GameOverBanner';
import { SharePanel } from './SharePanel';
import { TurnClocks } from './TurnClocks';
import { BUTTON_CLASS } from './ui';

/** How often the countdown is redrawn. Only ever a display; the clock is the room's. */
const TICK_MS = 250;

const PAGE_CLASS = 'mx-auto flex min-h-dvh w-full flex-col gap-3';
const PAGE_STYLE = { maxWidth: PAGE_MAX_PX, padding: BOARD_MARGIN_PX };

export function OnlineGame({ roomId }: { roomId: string }) {
  const [seat, setSeat] = useState<StoredSeat | null>(null);
  /** Seat resolution has finished; until then we do not know if we are playing. */
  const [seated, setSeated] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** Open while the room is waiting for its second player, until told otherwise. */
  const [shareToggled, setShareToggled] = useState<boolean | null>(null);
  /** The second tap of a double tap is a duplicate, not a second intent. */
  const [gate] = useState(() => new SingleFlight());

  /**
   * Whether this client is the player to move, asked of whatever room the hook
   * is holding (§7.3).
   *
   * A finished game is deliberately not spelled out here. Both readers already
   * have the result: `pollIntervalMs` takes `live` separately and slows to 5 s
   * on it whatever this answers, and `legalActions` returns `[]` once there is
   * a result, so `legal` is empty either way. A conjunct for it would be a
   * third statement of a rule the engine owns, and nothing could tell it from
   * a missing one.
   */
  const isYourTurn = useCallback(
    (current: PublicRoom) =>
      seat !== null &&
      current.seats.W &&
      current.seats.B &&
      current.game.turn === colourFor(seat, current.gameNumber),
    [seat],
  );

  const { room, status, skewMs, adopt, refresh } = useRoom(roomId, isYourTurn);

  // The room as of this render, for the effects that must not re-run on every
  // poll. Declared before them so it is already current when they fire.
  const roomRef = useRef<PublicRoom | null>(null);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  // — the seat (§5.1) ————————————————————————————————————————————————————
  // A token stored for this room means we are that seat; no token and a free
  // seat claims Black; anything else is a read-only visitor (§6.4). A browser
  // that will not store the token is a visitor too: a seat that cannot survive
  // a refresh is worse than none.
  //
  // This waits for the hook's first read rather than making one of its own: two
  // independent reads of the same room in the same tick is the one place this
  // client would race itself, and there is nothing here that the poll has not
  // already fetched.
  const roomLoaded = room !== null;
  useEffect(() => {
    if (!roomLoaded) return;
    let cancelled = false;

    async function resolve(): Promise<StoredSeat | null> {
      const stored = readSeat(roomId);
      if (stored !== null) return stored;
      if (!storageAvailable()) return null;

      const current = roomRef.current;
      if (current === null) return null;
      // The same condition `/join` itself refuses on, checked here only to save
      // a request that would certainly be refused. The 409 below is the authority.
      if (current.seats.B) return null;

      const joined = await joinRoom(roomId);
      if (!joined.ok) {
        if (joined.room !== undefined) adopt(joined.room);
        // Someone took the seat while we asked — possibly this very page in
        // another tab, whose token we now hold. Look again before giving up.
        return readSeat(roomId);
      }
      const claimed: StoredSeat = {
        token: joined.data.token,
        colour: joined.data.colour,
        gameNumber: joined.data.room.gameNumber,
      };
      // The other half of the front door's decision, and it goes the other way.
      // `/join` has already handed this seat out and there is no way to give it
      // back, so a write that does not land (a near-quota store: the probe
      // above takes one byte, this takes more) is not a reason to refuse the
      // seat. This tab plays on with a seat that will not survive a refresh,
      // which is strictly better for the room than a seat nobody holds.
      writeSeat(roomId, claimed);
      adopt(joined.data.room);
      return claimed;
    }

    void resolve().then((resolved) => {
      if (cancelled) return;
      setSeat(resolved);
      setSeated(true);
    });

    return () => {
      cancelled = true;
    };
  }, [roomLoaded, roomId, adopt]);

  // — the clock (§5.3) ———————————————————————————————————————————————————
  const clockRunning = room !== null && room.clockRunning && room.timerMs !== null;
  useEffect(() => {
    if (!clockRunning) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [clockRunning]);

  const you =
    room !== null && seat !== null ? colourFor(seat, room.gameNumber) : null;
  const yourTurn = room !== null && isYourTurn(room);
  const spectating = seated && seat === null;
  const legal = useMemo(
    () => (yourTurn && room !== null ? legalActions(room.game) : []),
    [yourTurn, room],
  );
  /**
   * A selection only means anything while that piece still has somewhere to go.
   * Deriving it rather than clearing it on every adopted room means no update
   * from the server — the turn passing, a rematch resetting the board — can
   * leave a selection pointing at a piece that is no longer there.
   */
  const selectedNow =
    selected !== null &&
    legal.some((action) => action.type === 'move' && action.from === selected)
      ? selected
      : null;

  // — mutations ——————————————————————————————————————————————————————————
  /**
   * Sends one intent and adopts the answer. A refusal carries the room as the
   * server really has it, so a rejected tap is also a resync — and is otherwise
   * silent (§6.2): no toast, nothing to dismiss, the tap is simply lost. The one
   * refusal that changes more than the board is the 403 that says this token
   * holds no seat: that gives the seat up, here and in `localStorage`. Which
   * request earned it makes no difference — see {@link seatIsRefused}, which is
   * why every call below sends the same thing.
   */
  const run = useCallback(
    (call: () => Promise<ApiResult<PublicRoom>>): Promise<void> =>
      gate.run(async () => {
        setBusy(true);
        try {
          const result = await call();
          if (result.ok) {
            adopt(result.data);
            return;
          }
          if (result.room === undefined) {
            // Nothing to adopt (a 404, or the request never left): re-read.
            await refresh();
            return;
          }
          adopt(result.room);
          if (seatIsRefused(result, seat)) {
            clearSeat(roomId);
            setSeat(null);
          }
        } finally {
          setBusy(false);
        }
      }),
    [adopt, refresh, roomId, seat, gate],
  );

  function handleTap(point: number) {
    if (room === null || seat === null) return;
    const outcome = interpretTap(legal, selectedNow, point);
    switch (outcome.kind) {
      case 'select':
        setSelected(outcome.point);
        return;
      case 'deselect':
        setSelected(null);
        return;
      case 'ignore':
        // §6.2: an illegal tap does nothing at all.
        return;
      case 'action': {
        const { action } = outcome;
        const version = room.version;
        setSelected(null);
        void run(() => sendAction(roomId, seat.token, action, version));
        return;
      }
    }
  }

  // — render —————————————————————————————————————————————————————————————
  // A 404 on the read is the server saying the room is gone — which can happen
  // mid-game, since rooms are kept for seven days (§7.2). It is shown whether or
  // not this client already has a board: a board nothing can change any more is
  // exactly the frozen, lying screen §7.3 exists to prevent.
  if (status === 'missing') {
    return (
      <main className={PAGE_CLASS} style={PAGE_STYLE}>
        <p className="text-base font-semibold" data-testid="no-room">
          This game is not here any more.
        </p>
        <p className="text-xs text-black/60">
          Rooms are kept for seven days. Start a fresh one.
        </p>
        <Link href="/" className={`${BUTTON_CLASS} grow-0`}>
          New game
        </Link>
      </main>
    );
  }

  if (room === null) {
    return (
      <main className={PAGE_CLASS} style={PAGE_STYLE}>
        <p className="text-sm text-black/60">Loading…</p>
      </main>
    );
  }

  const game = room.game;
  const live = game.result === null;
  const bothSeated = room.seats.W && room.seats.B;
  const remaining =
    room.timerMs === null
      ? 0
      : remainingMs(room.turnStartedAt, room.timerMs, serverNow(now, skewMs));
  const claimable =
    you !== null && clockRunning && game.turn !== you && canClaim(remaining);
  const drawOfferedToYou = you !== null && room.drawOffer[opponentOf(you)];
  const drawOfferedByYou = you !== null && room.drawOffer[you];
  /** §5.1: the link is what a room with one player in it is waiting for. */
  const shareOpen = shareToggled ?? !bothSeated;

  return (
    <main className={PAGE_CLASS} style={PAGE_STYLE}>
      {/* Until the second seat is claimed there is no turn to report: the board
          is shut and every action is refused, so §6.2's pairing applies — an
          inert board and a status bar that says why. `waiting` is what makes the
          headline say it; the viewer's own colour is passed throughout. */}
      <StatusBar
        state={game}
        you={you}
        spectating={spectating}
        waiting={!bothSeated}
      >
        {clockRunning && room.timerMs !== null && (
          <TurnClocks game={game} timerMs={room.timerMs} remaining={remaining} />
        )}
      </StatusBar>

      <GameOverBanner
        state={game}
        you={you}
        rematch={room.rematch}
        busy={busy}
        onRematch={() => {
          if (seat === null) return;
          void run(() => offerRematch(roomId, seat.token));
        }}
      />

      <Board
        state={game}
        legal={legal}
        selected={selectedNow}
        onPointTap={seat === null ? undefined : handleTap}
      />

      <div className="flex-1" />

      <BottomBar state={game}>
        {/* §6.4 reserves "Spectating" for someone who really has no seat, so it
            waits for the same `seated` flag the status bar does: between the
            first read and the answer from `/join`, this client does not yet know
            what it is. */}
        <p className="w-full text-xs text-black/60" data-testid="you">
          {!seated
            ? 'Finding your seat…'
            : you === null
              ? 'Spectating'
              : `You play ${PLAYER_NAME[you]}`}
        </p>
        {claimable && seat !== null && (
          <button
            type="button"
            onClick={() => void run(() => claimTimeout(roomId, seat.token))}
            disabled={busy}
            data-testid="claim"
            className={BUTTON_CLASS}
          >
            Claim win
          </button>
        )}
        {/* Resign and Offer draw appear together, once there is a game to give
            up: `/action` refuses every action — resignation included — while a
            seat is empty, and a button that can only be refused is worse than
            no button (§6.2: nothing is ever surfaced as an error). */}
        {live && bothSeated && seat !== null && (
          <button
            type="button"
            onClick={() => void run(() => resignGame(roomId, seat.token, room))}
            disabled={busy}
            data-testid="resign"
            className={BUTTON_CLASS}
          >
            Resign
          </button>
        )}
        {live && bothSeated && seat !== null && (
          <button
            type="button"
            onClick={() =>
              // `drawOfferedToYou` is the bit the label below is chosen from, so
              // what the server is told this tap meant is what the player read.
              void run(() => offerDraw(roomId, seat.token, room, drawOfferedToYou))
            }
            disabled={busy || drawOfferedByYou}
            data-testid="draw"
            className={BUTTON_CLASS}
          >
            {drawOfferedToYou
              ? 'Accept draw'
              : drawOfferedByYou
                ? 'Draw offered'
                : 'Offer draw'}
          </button>
        )}
        {/* §6.1 puts the share link in the bottom bar, with the counts and the
            other controls. It stays there for the life of the room: a game in
            progress is still worth sending to someone who will watch it (§6.4).
            Collapsed by default once both seats are filled, so the board keeps
            the space at 360 px. */}
        {seat !== null && (
          <button
            type="button"
            onClick={() => setShareToggled(!shareOpen)}
            data-testid="share-toggle"
            className={BUTTON_CLASS}
          >
            {shareOpen ? 'Hide link' : 'Share link'}
          </button>
        )}
        {seat !== null && shareOpen && <SharePanel waiting={!bothSeated} />}
      </BottomBar>
    </main>
  );
}
