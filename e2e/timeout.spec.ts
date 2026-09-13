/**
 * The timeout claim, end to end (GDD §8.3, third e2e; §5.3).
 *
 * There is no auto-forfeit: when the active player's clock runs out, the
 * *opponent's* client offers **Claim win** and the server validates the elapsed
 * time against its own clock. Both halves are asserted here — the claim refused
 * while the clock is still running, and honoured once it is not.
 *
 * The room is created through the API so it can carry the twelve-second timer
 * below, which only `MORRIS_E2E=1` allows (`src/lib/api/schemas.ts`); the UI
 * offers the four real choices of §5.3, the shortest of which is a minute. The
 * two seats are then seeded into their browsers exactly as the client stores
 * them, so the pages open already seated.
 *
 * The second spec is the same clock read by a browser whose own is a minute
 * fast, which is what `skewMs` exists for. Its room takes one of §5.3's real
 * timers — a minute — and goes through the API only to seed the two seats.
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { REFUSAL } from '../src/lib/api';
import type { CreateGameResponse, JoinResponse } from '../src/lib/api/types';
import {
  ON_THE_IDLE_POLL,
  expectBoardInert,
  expectNoHorizontalScroll,
  expectTapTarget,
  newViewportContext,
  seatLabel,
  seedSeat,
  statusHeadline,
} from './helpers';

/**
 * Long enough that the pages are up and the "not yet" assertions have run while
 * the clock is still going, short enough that waiting it out is seconds. The
 * clock starts when the second seat is claimed, not at creation.
 */
const TIMER_MS = 12_000;

/**
 * A minute of clock error, in the direction that makes the client early — a
 * device whose owner never set the time, or one that has drifted. `skewMs` is
 * measured as `serverNow - Date.now()` at every response, so the correction is
 * a minute the other way; without it every reading in the skewed page is a
 * minute out.
 */
const SKEW_MS = 60_000;

/** §5.3's shortest real choice, and the one a minute of skew swallows whole. */
const MINUTE_MS = 60_000;

test('a timeout claim is refused before the clock expires and wins after it', async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const contexts: BrowserContext[] = [];

  const created = await request.post('/api/game', { data: { timerMs: TIMER_MS } });
  expect(created.status()).toBe(200);
  const { roomId, token: whiteToken }: CreateGameResponse = await created.json();

  const joined = await request.post(`/api/game/${roomId}/join`);
  expect(joined.status()).toBe(200);
  const { token: blackToken }: JoinResponse = await joined.json();

  // §5.3: the server validates the elapsed time. White is on the clock and it
  // has just started, so Black's claim is refused — and the room is unchanged.
  const early = await request.post(`/api/game/${roomId}/claim-timeout`, {
    data: { token: blackToken },
  });
  expect(early.status()).toBe(409);
  expect(await early.json()).toMatchObject({ error: REFUSAL.clockNotExpired });

  try {
    const white = page;
    await seedSeat(white.context(), roomId, {
      token: whiteToken,
      colour: 'W',
      gameNumber: 1,
    });
    const blackContext = await newViewportContext(browser);
    contexts.push(blackContext);
    await seedSeat(blackContext, roomId, {
      token: blackToken,
      colour: 'B',
      gameNumber: 1,
    });
    const black: Page = await blackContext.newPage();

    await white.goto(`/g/${roomId}`);
    await black.goto(`/g/${roomId}`);
    await expect(seatLabel(white)).toHaveText('You play White');
    await expect(seatLabel(black)).toHaveText('You play Black');

    // §5.3: a countdown for both players, White's running.
    await expect(white.getByTestId('clock-W')).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(black.getByTestId('clock-W')).toHaveAttribute(
      'data-active',
      'true',
    );
    // Nothing to claim yet: the clock is still White's.
    await expect(black.getByTestId('claim')).toHaveCount(0);
    await expectNoHorizontalScroll(black);

    // Under ten seconds, the running clock goes red (§5.3). Colour is not the
    // only signal — `data-urgent` is what the class is driven from.
    await expect(black.getByTestId('clock-W')).toHaveAttribute(
      'data-urgent',
      'true',
      { timeout: 20_000 },
    );

    // The real clock has to pass; the test waits on the button appearing, not on
    // a fixed sleep, and the button appears only once the claim will be honoured.
    await expect(black.getByTestId('claim')).toBeVisible({ timeout: 30_000 });
    await expect(white.getByTestId('clock-W')).toContainText('0:00');
    // The clock is White's own: only the opponent may claim it (§5.3).
    await expect(white.getByTestId('claim')).toHaveCount(0);

    await expectTapTarget(black.getByTestId('claim'));
    await black.getByTestId('claim').click();

    // The claimer has the answer in the response to its own call…
    await expect(statusHeadline(black)).toHaveText('Black wins — forfeit');
    await expect(black.getByTestId('result-winner')).toHaveText('You win.');
    // …and the forfeiting player finds out on its next poll. It is the player
    // on the clock, so it is on §7.3's 5 s idle interval right up until the
    // moment its opponent claims the win.
    await expect(statusHeadline(white)).toHaveText(
      'Black wins — forfeit',
      ON_THE_IDLE_POLL,
    );
    await expect(white.getByTestId('result-winner')).toHaveText('You lose.');
    for (const player of [white, black]) {
      await expect(player.getByTestId('result-reason')).toHaveText(
        'Black wins — forfeit',
      );
      await expectBoardInert(player);
    }
    // The countdown goes when the game does.
    await expect(black.getByTestId('claim')).toHaveCount(0);
    await expect(black.getByTestId('clock-W')).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('a client whose own clock is a minute fast still reads the room\'s', async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const contexts: BrowserContext[] = [];

  // A one-minute timer: one of §5.3's four, and the one where a minute of skew
  // is the whole allowance. The UI offers it, but the two seats are seeded the
  // way the rest of this file seeds them so the pages open already playing.
  const created = await request.post('/api/game', {
    data: { timerMs: MINUTE_MS },
  });
  expect(created.status()).toBe(200);
  const { roomId, token: whiteToken }: CreateGameResponse = await created.json();
  const joined = await request.post(`/api/game/${roomId}/join`);
  expect(joined.status()).toBe(200);
  const { token: blackToken }: JoinResponse = await joined.json();

  try {
    const white = page;
    await seedSeat(white.context(), roomId, {
      token: whiteToken,
      colour: 'W',
      gameNumber: 1,
    });
    const blackContext = await newViewportContext(browser);
    contexts.push(blackContext);
    // Black's browser is a minute fast, from before the first script runs.
    await blackContext.addInitScript((offset: number) => {
      const real = Date.now.bind(Date);
      Date.now = () => real() + offset;
    }, SKEW_MS);
    await seedSeat(blackContext, roomId, {
      token: blackToken,
      colour: 'B',
      gameNumber: 1,
    });
    const black: Page = await blackContext.newPage();

    await white.goto(`/g/${roomId}`);
    await black.goto(`/g/${roomId}`);
    await expect(seatLabel(white)).toHaveText('You play White');
    await expect(seatLabel(black)).toHaveText('You play Black');

    // §5.3: the countdown is the room's clock, corrected to this browser's, and
    // both pages draw the same seconds. An uncorrected client a minute fast
    // reads a one-minute timer as spent from the first second — 0:00 for the
    // whole game, in red, on a clock that is really still running.
    await expect(black.getByTestId('clock-W')).toContainText(/0:[3-5]\d/);
    await expect(white.getByTestId('clock-W')).toContainText(/0:[3-5]\d/);
    await expect(black.getByTestId('clock-W')).not.toHaveAttribute(
      'data-urgent',
      'true',
    );

    // …and the claim reads the same clock. Offered at a false 0:00 it is
    // answered `clockNotExpired` — the tap that does nothing that
    // `CLAIM_GRACE_MS` exists to prevent, handed to the opponent for the whole
    // minute before the claim is real. The claim that *is* real is the spec
    // above; this is the state it must not be offered in.
    await expect(black.getByTestId('claim')).toHaveCount(0);
    const refused = await request.post(`/api/game/${roomId}/claim-timeout`, {
      data: { token: blackToken },
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: REFUSAL.clockNotExpired,
    });

    // The clock is the only thing under test here: the game is still on.
    await expect(statusHeadline(white)).toHaveText('Your turn');
    await expect(statusHeadline(black)).toHaveText('Waiting for White…');
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
