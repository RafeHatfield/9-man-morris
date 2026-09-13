/**
 * Online mode, end to end (GDD §8.3, first e2e): two browser contexts play a
 * complete scripted game through the real API — `MemoryStore`, no Redis — to a
 * mill-out win, then rematch and swap colours. This is the headline spec; the
 * three sibling files cover seats (`online-seats`), refusals and races
 * (`online-races`) and polling (`online-polling`), sharing `helpers.ts`.
 *
 * Nothing here waits on a clock to decide whether the app is right. The two
 * pages are synchronised on what they *say*: each ply waits for the player who
 * is about to act to be told it is their turn, which is also the assertion that
 * the other client's poll (§7.3) has caught up. There is no `waitForTimeout` in
 * this file — only the two raised timeouts of `helpers.ts`, which stand for one
 * interval of §7.3's 5 s idle poll where a page is on it.
 *
 * Runs at both mobile viewports (`playwright.config.ts`); the second context is
 * opened at the same size, so §8.4's no-horizontal-scroll holds for both players.
 */

import { expect, test, type BrowserContext } from '@playwright/test';
import {
  AFTER_GAME_OVER,
  ON_THE_IDLE_POLL,
  TIMER,
  counts,
  createRoom,
  expectBoardInert,
  expectNoHorizontalScroll,
  expectTapTarget,
  openRoom,
  playActions,
  point,
  seatLabel,
  seatedRoom,
  shareLink,
  statusDetail,
  statusHeadline,
} from './helpers';
import { MILL_OUT_GAME } from './scripted-game';

let contexts: BrowserContext[] = [];

test.beforeEach(() => {
  contexts = [];
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
});

test('two players play a scripted game to a mill-out win, then rematch with the colours swapped', async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const white = page;

  // §5.1: create, then share. The default timer is five minutes (§5.3).
  await white.goto('/');
  await expect(white.getByTestId(TIMER.fiveMinutes)).toHaveAttribute(
    'data-checked',
    'true',
  );
  // §6.2: every control on the way in is a real tap target at 360 px too.
  await expectTapTarget(white.getByTestId('new-game'));
  await expectTapTarget(white.getByTestId(TIMER.none));
  const roomId = await createRoom(white, TIMER.fiveMinutes);

  // §5.1, §6.3: the share panel, with the link and a Copy that says "Copied".
  await expect(white.getByTestId('share')).toBeVisible();
  // §5.1: the panel is open here because the room is waiting for the person
  // this link is for, and that is what it says. The other wording — "Both seats
  // are taken. Anyone else who opens this link can watch." — is the opposite of
  // the truth on the one screen between "create" and "the opponent arrives".
  await expect(white.getByTestId('share')).toContainText('Send this link');
  await expect(shareLink(white)).toHaveValue(new RegExp(`/g/${roomId}$`));
  await white.context().grantPermissions(['clipboard-write']);
  await expectTapTarget(white.getByTestId('copy'));
  await white.getByTestId('copy').click();
  await expect(white.getByTestId('copy')).toHaveText('Copied');
  await expect(white.getByTestId('copy')).toHaveText('Copy'); // 1.5 s later
  await expectNoHorizontalScroll(white);

  // §6.2: the link is a tap target too — it is selected by hand when the
  // clipboard is refused.
  await expectTapTarget(shareLink(white));

  // §6.2: an inert board, and a status bar that says why it is inert. A seated
  // player is never told it is their turn over a board that refuses every tap.
  await expect(statusHeadline(white)).toHaveText('Waiting for an opponent…');
  await expectBoardInert(white);

  // §5.1: the first other visitor claims Black.
  const black = await openRoom(browser, contexts, roomId);
  await expect(seatLabel(black)).toHaveText('You play Black');
  // Sampled rather than waited for, as in `seatedRoom`: the join's own answer
  // is the room whose clock has just started (§5.3), so the countdown is on
  // screen with the seat and not one poll behind it.
  expect(await black.getByTestId('clock-W').count()).toBe(1);
  expect(await statusHeadline(black).textContent()).toBe('Waiting for White…');
  // …and now there is a turn to report.
  await expect(statusHeadline(white)).toHaveText('Your turn');
  await expect(statusHeadline(black)).toHaveText('Waiting for White…');
  // The panel folds itself away once the room has what it was waiting for…
  await expect(white.getByTestId('share')).toHaveCount(0);
  // …but §6.1 keeps the link in the bottom bar for the life of the room: a game
  // in progress is still worth sending to someone who will watch it (§6.4).
  await expectTapTarget(white.getByTestId('share-toggle'));
  await white.getByTestId('share-toggle').click();
  await expect(white.getByTestId('share')).toBeVisible();
  // …and now the room is not waiting for anybody, so the panel says the other
  // thing: the link is for whoever wants to watch (§6.4).
  await expect(white.getByTestId('share')).toContainText('Share this game');
  await expect(shareLink(white)).toHaveValue(new RegExp(`/g/${roomId}$`));
  await white.getByTestId('share-toggle').click();
  await expect(white.getByTestId('share')).toHaveCount(0);
  await expectNoHorizontalScroll(white);

  // §5.3: a countdown for both players, drawn only now that the clock runs.
  await expect(white.getByTestId('clock-W')).toHaveAttribute(
    'data-active',
    'true',
  );
  await expect(white.getByTestId('clock-B')).toContainText('5:00');
  await expect(black.getByTestId('clock-W')).toHaveAttribute(
    'data-active',
    'true',
  );

  // The scripted game, one ply at a time. Who is to act is derived from the
  // script alone — the turn passes on every action except the removal a mill
  // earns (§4.5) — and then confirmed by the page before every single tap.
  let turn: 'W' | 'B' = 'W';
  for (const [i, action] of MILL_OUT_GAME.entries()) {
    const actor = turn === 'W' ? white : black;
    await expect(statusHeadline(actor)).toHaveText('Your turn');
    await playActions(actor, [action]);
    const next = MILL_OUT_GAME[i + 1];
    if (next !== undefined && next.type !== 'remove') {
      turn = turn === 'W' ? 'B' : 'W';
    }
  }

  // §6.3: both clients show the result and the reason.
  for (const player of [white, black]) {
    await expect(statusHeadline(player)).toHaveText('White wins — mill-out');
    await expect(player.getByTestId('result-reason')).toHaveText(
      'White wins — mill-out',
    );
    await expect(counts(player, 'B').board).toHaveText('2');
    await expectBoardInert(player);
    await expectNoHorizontalScroll(player);
  }
  await expect(white.getByTestId('result-winner')).toHaveText('You win.');
  await expect(black.getByTestId('result-winner')).toHaveText('You lose.');
  // The clock stops with the game (§5.3: `clockRunning`).
  await expect(white.getByTestId('clock-W')).toHaveCount(0);

  // §5.4: one player offers, the other accepts, and the room resets in place.
  await expectTapTarget(white.getByTestId('rematch'));
  await white.getByTestId('rematch').click();
  await expect(white.getByTestId('rematch')).toHaveText('Rematch offered');
  await expect(black.getByTestId('rematch')).toHaveText(
    'Accept rematch',
    AFTER_GAME_OVER,
  );
  await black.getByTestId('rematch').click();

  // Same URL, same tokens, colours swapped. White still moves first (§9), so
  // the swap shows in who holds which colour — and who is now waiting.
  expect(white.url()).toContain(`/g/${roomId}`);
  await expect(white.getByTestId('game-over')).toHaveCount(0, AFTER_GAME_OVER);
  await expect(seatLabel(white)).toHaveText('You play Black');
  await expect(seatLabel(black)).toHaveText('You play White');
  await expect(statusHeadline(black)).toHaveText('Your turn');
  await expect(statusHeadline(white)).toHaveText('Waiting for White…');
  await expect(statusDetail(white)).toHaveText('Placement');
  await expect(counts(white, 'W').hand).toHaveText('9');
  await expect(counts(white, 'B').hand).toHaveText('9');
  await expect(counts(white, 'W').board).toHaveText('0');

  // And the new White — the joiner — plays on.
  await playActions(black, [{ type: 'place', point: 0 }]);
  await expect(point(white, 0)).toHaveAccessibleName('Point 0, White piece');
  await expect(statusHeadline(white)).toHaveText('Your turn');
  await expectNoHorizontalScroll(white);
});

test('a draw is offered and accepted', async ({ browser, page }) => {
  const white = page;
  const { black } = await seatedRoom(browser, contexts, white);

  // §4.6: one player offers…
  await expectTapTarget(white.getByTestId('draw'));
  await white.getByTestId('draw').click();
  await expect(white.getByTestId('draw')).toHaveText('Draw offered');
  await expect(white.getByTestId('draw')).toBeDisabled();

  // …and the other sees the offer and takes it.
  await expect(black.getByTestId('draw')).toHaveText('Accept draw');
  await black.getByTestId('draw').click();

  // White is the player to move, so it is on §7.3's 5 s idle interval and this
  // acceptance — made by the other seat, out of turn — takes up to one of them
  // to arrive. Black has the answer to its own tap and passes at once.
  for (const player of [white, black]) {
    await expect(
      statusHeadline(player),
      'the acceptance crosses on the idle poll',
    ).toHaveText('Draw — agreed', ON_THE_IDLE_POLL);
    await expect(player.getByTestId('result-winner')).toHaveText('A draw.');
    await expectBoardInert(player);
  }
});
