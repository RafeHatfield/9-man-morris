/**
 * Who is playing and who is only watching (GDD §5.1, §6.4).
 *
 * Two rules, and every spec here is one of them. **§6.4**: a read-only visitor
 * sees the board and the status and gets no controls — asserted only in rooms
 * where the control under test really is drawn for somebody, since the absence
 * of a button nobody could have is not a fact about the seat. **§5.1**: the seat
 * is a bearer token in `localStorage`, so a browser that cannot keep one
 * spectates rather than silently losing the seat later.
 *
 * Runs at both mobile viewports; every extra context is opened at the same size.
 */

import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  AFTER_GAME_OVER,
  TIMER,
  counts,
  createRoom,
  expectBoardInert,
  expectNoHorizontalScroll,
  newViewportContext,
  openRoom,
  playActions,
  point,
  seatLabel,
  seatedRoom,
  statusDetail,
  statusHeadline,
} from './helpers';

let contexts: BrowserContext[] = [];

test.beforeEach(() => {
  contexts = [];
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
});

/** A context whose `localStorage` throws when it is touched (private mode). */
async function blockStorage(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage is blocked');
      },
    });
  });
}

test('a third visitor is read-only', async ({ browser, page }) => {
  const white = page;
  const { roomId, black } = await seatedRoom(browser, contexts, white);

  // §5.1: the seats are taken, so this one only watches.
  const visitor = await openRoom(browser, contexts, roomId);
  // This is the anchor for everything below: "Spectating" is only ever shown
  // once seat resolution has finished, so the absence of controls after it is
  // the absence of controls for someone who really has no seat (§6.4).
  await expect(seatLabel(visitor)).toHaveText('Spectating');
  await expect(statusDetail(visitor)).toContainText('Spectating');
  await expectBoardInert(visitor);

  // §6.4: the board and the status, and no controls at all. Only the three a
  // live, timer-less room with both seats filled can actually draw are listed —
  // and the seated player has all three, which is what makes their absence here
  // a fact about the seat. `rematch` needs a finished game, and that room is the
  // spec below.
  for (const control of ['resign', 'draw', 'share-toggle']) {
    await expect(black.getByTestId(control)).toBeVisible();
    await expect(visitor.getByTestId(control)).toHaveCount(0);
  }

  // It does follow the game, though.
  await playActions(white, [{ type: 'place', point: 5 }]);
  await expect(point(visitor, 5)).toHaveAccessibleName('Point 5, White piece');
  await expect(statusHeadline(visitor)).toHaveText('Black to play');
  await expect(counts(visitor, 'W').board).toHaveText('1');
  await expectNoHorizontalScroll(visitor);

  // And the seated players are unaffected by it.
  await expect(seatLabel(black)).toHaveText('You play Black');
  await expect(statusHeadline(black)).toHaveText('Your turn');
});

test('a spectator watching a finished game gets the result and no rematch', async ({
  browser,
  page,
}) => {
  const white = page;
  const { roomId, black } = await seatedRoom(browser, contexts, white);

  // §4.6: the quickest way to a finished game. The visitor arrives after it.
  await white.getByTestId('resign').click();
  await expect(statusHeadline(white)).toHaveText('Black wins — resignation');

  const visitor = await openRoom(browser, contexts, roomId);
  await expect(seatLabel(visitor)).toHaveText('Spectating');

  // §6.3, §6.4: the result and the reason, in the wording for someone who is
  // neither player — and nothing to do about it.
  await expect(visitor.getByTestId('game-over')).toBeVisible();
  await expect(visitor.getByTestId('result-winner')).toHaveText('Black wins.');
  await expect(visitor.getByTestId('result-reason')).toHaveText(
    'Black wins — resignation',
  );

  // The controls exist in this state — the seated player has them, which is what
  // makes their absence below a fact about the seat rather than about the game.
  // Black's game is over, so it is on §7.3's 5 s poll and learns of the
  // resignation one idle interval late.
  await expect(black.getByTestId('rematch')).toBeVisible(AFTER_GAME_OVER);
  await expect(black.getByTestId('new-game-link')).toBeVisible();
  await expect(visitor.getByTestId('rematch')).toHaveCount(0);
  await expect(visitor.getByTestId('new-game-link')).toHaveCount(0);
  await expectBoardInert(visitor);
  await expectNoHorizontalScroll(visitor);
});

test('a player is not called a spectator while their seat is being claimed', async ({
  browser,
  page,
}) => {
  const roomId = await createRoom(page, TIMER.none);

  const joiner = await newViewportContext(browser);
  contexts.push(joiner);
  // Hold the join open: between the first read and the answer, this client does
  // not yet know whether it has a seat.
  await joiner.route('**/api/game/*/join', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await route.continue();
  });
  const black = await joiner.newPage();
  await black.goto(`/g/${roomId}`);

  // Sampled once, while the join is still out: §6.4 reserves "Spectating" for a
  // visitor who really has no seat, and this one is about to have Black.
  await expect(seatLabel(black)).toBeVisible();
  expect(await seatLabel(black).textContent()).toBe('Finding your seat…');
  // The other half of the same sentence, sampled in the same instant: §6.4's
  // word is the status bar's second line too, and a page saying "Finding your
  // seat…" at the bottom must not say "Placement · Spectating" at the top.
  expect(await statusDetail(black).textContent()).toBe('Placement');

  await expect(seatLabel(black)).toHaveText('You play Black', {
    timeout: 20_000,
  });
});

test('the tab that loses the join race still finds its seat', async ({
  browser,
  page,
}) => {
  const roomId = await createRoom(page, TIMER.none);

  // Two tabs of one browser, so they share the `localStorage` the seat lives in
  // (§5.1) — one person opening their own link twice. Both read no seat and
  // both ask to join, and the server seats exactly one of them.
  const joiner = await newViewportContext(browser);
  contexts.push(joiner);
  const first = await joiner.newPage();
  const second = await joiner.newPage();
  // Which tab loses is chosen rather than raced for: both joins are held until
  // after both pages have read the room and found Black free, and the second is
  // held until the first has answered and written the token. That is the case
  // the re-read exists for, and a real race only lands on it sometimes.
  const held = (tab: Page, ms: number) =>
    tab.route('**/api/game/*/join', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await route.continue();
    });
  await held(first, 1_000);
  await held(second, 4_000);

  await Promise.all([first.goto(`/g/${roomId}`), second.goto(`/g/${roomId}`)]);

  // §6.4 reserves "Spectating" for a visitor who really has no seat. The loser
  // holds the winner's token, so it is a player too — and without the re-read
  // it sits there captioned "Spectating" over its own seat until a reload.
  await expect(seatLabel(first)).toHaveText('You play Black', {
    timeout: 20_000,
  });
  await expect(seatLabel(second)).toHaveText('You play Black', {
    timeout: 20_000,
  });
  await expect(statusHeadline(second)).toHaveText('Waiting for White…');
  await expect(seatLabel(page)).toHaveText('You play White');
});

test('a browser that will not store a token spectates rather than taking the seat', async ({
  browser,
  page,
}) => {
  const roomId = await createRoom(page, TIMER.none);

  const blocked = await newViewportContext(browser);
  contexts.push(blocked);
  await blockStorage(blocked);
  const visitor = await blocked.newPage();
  await visitor.goto(`/g/${roomId}`);

  // §5.1: a seat that could not survive a refresh is not claimed at all.
  await expect(seatLabel(visitor)).toHaveText('Spectating');

  // §6.4's "no controls", made where it can fail. This room is still waiting
  // for its second player, so the share panel is open — and it is the one
  // control a room in this state draws at all: `resign`, `draw`, `rematch` and
  // `claim` are gated on a game that is being played, for the seated player as
  // much as for this one. The creator has the panel and the toggle, which is
  // what makes their absence here a fact about the seat. Without this, a
  // read-only visitor gets the link input, Copy and the native Share sheet for
  // a room they cannot sit in.
  for (const control of ['share', 'share-toggle']) {
    await expect(page.getByTestId(control)).toBeVisible();
    await expect(visitor.getByTestId(control)).toHaveCount(0);
  }

  // And the two controls the creator does *not* have while the room waits.
  // `/action` refuses every action — resignation included — until both seats
  // are filled, so either button could only ever be answered 409 over a page
  // still reading "Waiting for an opponent…", and §6.2 surfaces nothing as an
  // error: a button that can only be refused is worse than no button.
  for (const control of ['resign', 'draw']) {
    await expect(page.getByTestId(control)).toHaveCount(0);
  }

  // The seat it declined is still free for the next visitor.
  const black = await openRoom(browser, contexts, roomId);
  await expect(seatLabel(black)).toHaveText('You play Black');
});

test('a browser that will not store a token is not sent to a room at all', async ({
  browser,
}) => {
  const blocked = await newViewportContext(browser);
  contexts.push(blocked);
  await blockStorage(blocked);
  const home = await blocked.newPage();
  let roomsCreated = 0;
  home.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/game'
    ) {
      roomsCreated += 1;
    }
  });

  await home.goto('/');
  await expect(home.getByTestId('no-seat-storage')).toHaveCount(0);
  await home.getByTestId('new-game').click();

  // §5.1: the token is the seat. Creating the room anyway would leave White's
  // seat held by a browser that cannot keep the token, the creator spectating
  // their own game, and the room unplayable by anyone — so the room is not made.
  await expect(home.getByTestId('no-seat-storage')).toBeVisible();
  expect(new URL(home.url()).pathname).toBe('/');
  expect(roomsCreated).toBe(0);
  // §6.2: nothing is an error, and the button comes back.
  await expect(home.getByTestId('new-game')).toBeEnabled();
  await expectNoHorizontalScroll(home);
});
