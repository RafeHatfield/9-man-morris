/**
 * The poll, from outside the page (GDD §7.3).
 *
 * "Client polls `GET /api/game/[id]` every 1.5 s while the game is live and it
 * is *not* the client's turn; every 5 s otherwise; stops when the tab is hidden
 * and resumes on focus." The interval itself is a pure function with its own
 * unit tests (`src/lib/client/polling.ts`); what only an e2e can say is that it
 * is wired to a real tab — that a hidden one really stops reading, that focus
 * really starts it again, and that the one answer which stops it for good is
 * this server's own 404 and nothing that merely looks like one.
 *
 * Nothing here sleeps. Requests are counted rather than timed, and a second page
 * that is *not* hidden is the clock for the one that is: a spectator on the same
 * 1.5 s interval measures the window in the hidden tab's own poll intervals, so
 * an assertion cannot pass because a wait happened to be short.
 */

import { expect, test, type BrowserContext } from '@playwright/test';
import { REFUSAL } from '../src/lib/api';
import {
  allPoints,
  countRoomReads,
  openRoom,
  playActions,
  point,
  seatLabel,
  seatedRoom,
  setTabHidden,
  statusHeadline,
} from './helpers';

let contexts: BrowserContext[] = [];

test.beforeEach(() => {
  contexts = [];
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
});

test('a hidden tab stops reading the room, and reads again when it comes back', async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  const white = page;
  const { roomId, black } = await seatedRoom(browser, contexts, white);
  await playActions(white, [{ type: 'place', point: 5 }]);
  await expect(statusHeadline(white)).toHaveText('Waiting for Black…');

  // The spectator is the clock: live, and never its turn, so it sits on the
  // same 1.5 s interval White does.
  const spectator = await openRoom(browser, contexts, roomId);
  await expect(seatLabel(spectator)).toHaveText('Spectating');
  const whiteReads = countRoomReads(white);
  const spectatorReads = countRoomReads(spectator);

  // White really is polling before it is hidden — §7.3's 1.5 s, since the game
  // is live and it is Black's turn. Without this the flat count below could be
  // flat for a reason that has nothing to do with being hidden.
  await expect.poll(whiteReads, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);

  await setTabHidden(white, true);
  // One spectator read to let anything already in flight be counted, and then
  // the number that must not move.
  const settle = spectatorReads();
  await expect
    .poll(spectatorReads, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(settle + 1);
  const frozen = whiteReads();

  // Black plays. §7.3 stops the polling, so White cannot learn of it: what the
  // request count says is also a whole game state this tab does not have.
  await playActions(black, [{ type: 'place', point: 19 }]);
  await expect(statusHeadline(black)).toHaveText('Waiting for White…');

  // Four more of White's own poll intervals, measured by the spectator. A tab
  // that goes on polling costs a request every 1.5 s against Upstash, for ever.
  await expect
    .poll(spectatorReads, { timeout: 40_000 })
    .toBeGreaterThanOrEqual(settle + 5);
  expect(whiteReads()).toBe(frozen);
  await expect(point(white, 19)).toHaveAccessibleName('Point 19, empty');
  await expect(statusHeadline(white)).toHaveText('Waiting for Black…');

  // …and §7.3's other half: it resumes on focus, and catches up.
  await setTabHidden(white, false);
  await expect(statusHeadline(white)).toHaveText('Your turn');
  await expect(point(white, 19)).toHaveAccessibleName('Point 19, Black piece');
  expect(whiteReads()).toBeGreaterThan(frozen);
});

test('a tab that comes back reads at once, rather than waiting for the next poll', async ({
  browser,
  page,
}) => {
  const white = page;
  const { black } = await seatedRoom(browser, contexts, white);
  await expect(white.getByTestId('draw')).toHaveText('Offer draw');

  await setTabHidden(white, true);

  // Black offers a draw. White is hidden, so nothing tells it — and the wait on
  // Black's own button is the server having answered, which is what makes the
  // line after it a statement about a page that has had every chance to be
  // wrong rather than one asserted before anything could have changed.
  await black.getByTestId('draw').click();
  await expect(black.getByTestId('draw')).toHaveText('Draw offered');
  await expect(white.getByTestId('draw')).toHaveText('Offer draw');

  const reads = countRoomReads(white);
  // Visible and hidden again inside one task. The read on focus is dispatched
  // by the handler itself, synchronously; the interval it also restarts is
  // cleared before it can ever fire. So that one read is the only thing that
  // can teach this page anything, and no timeout stands in for it — without it
  // the page stays on the game it was holding for as long as the test waits.
  await white.evaluate(() => {
    for (const state of ['visible', 'hidden']) {
      Object.defineProperty(document, 'visibilityState', {
        value: state,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });

  await expect(white.getByTestId('draw')).toHaveText('Accept draw', {
    timeout: 20_000,
  });
  expect(reads()).toBe(1);
});

test('a room that disappears mid-game says so, and one 404 from something in the way does not', async ({
  browser,
  page,
}) => {
  const white = page;
  const { black } = await seatedRoom(browser, contexts, white);
  await playActions(white, [{ type: 'place', point: 5 }]);
  await expect(statusHeadline(white)).toHaveText('Waiting for Black…');

  // Reading a 404 as "the room is gone" stops the polling for good and nothing
  // restarts it, so the two answers below must be told apart. Only the second
  // is this server's: the first is an edge, a proxy or a mid-redeploy, and it
  // answers in the envelope shape on purpose, because a check that only looks
  // for one is defeated by exactly that.
  let mode: 'spoil' | 'pass' | 'gone' = 'spoil';
  await white.route('**/api/game/*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    if (mode === 'pass') {
      await route.continue();
      return;
    }
    if (mode === 'spoil') mode = 'pass';
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: mode === 'gone' ? REFUSAL.roomNotFound : 'Not Found',
      }),
    });
  });

  // One unattributable 404, and the game carries on: the poll is still running,
  // so Black's move arrives as usual.
  await playActions(black, [{ type: 'place', point: 19 }]);
  await expect(statusHeadline(white)).toHaveText('Your turn', {
    timeout: 20_000,
  });
  await expect(white.getByTestId('no-room')).toHaveCount(0);

  // And now the room really is gone — reachable in a real game, since rooms are
  // kept for seven days (§7.2). §7.3: what the client must not do is keep
  // drawing a board it can no longer act on and telling the player whose turn
  // it is.
  mode = 'gone';
  await expect(white.getByTestId('no-room')).toBeVisible({ timeout: 20_000 });
  await expect(allPoints(white)).toHaveCount(0);
  await expect(white.getByTestId('resign')).toHaveCount(0);
  await expect(white.getByTestId('status-headline')).toHaveCount(0);
});
