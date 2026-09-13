/**
 * The mobile pass (GDD §8.4).
 *
 * Two jobs. It takes the screenshots the critic reviews for overlap and cut-off
 * text, and it asserts the things a screenshot cannot show: no horizontal
 * scroll, every tap target at least 44 × 44 px as rendered (§6.2) — including
 * all 24 board points, which the other specs only spot-check — and that the two
 * `truncate`d lines of the status bar are not actually clipping their text.
 *
 * The shots are chosen to be the screens most likely to break. Four come from
 * the pages a single browser can reach — home, a selection, removal mode, and
 * the hot-seat game-over banner — plus a fifth for the other half of §6.2's
 * removal mode, a mill-protected Black position that `MILL_OUT_GAME` never
 * reaches. Three more need a room with people in it: `/g/[roomId]` draws two
 * turn clocks *inside* the status-bar row, a 288 px share panel holding a full
 * URL, the "Spectating" caption and a game-over banner of its own, and none of
 * that exists in hot-seat.
 *
 * Like every spec here it runs at both viewports, so the screenshots and the
 * measurements exist for 360 × 740 and 390 × 844 alike.
 */

import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import {
  TIMER,
  allPoints,
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
import { TIMER_CHOICES } from '../src/lib/api/types';
import type { Action } from '../src/lib/engine';
import {
  MILL_OUT_GAME,
  OPENING,
  PROTECTED_LOOSE,
  PROTECTED_MILL,
  PROTECTED_REMOVAL,
} from './scripted-game';

let contexts: BrowserContext[] = [];

test.beforeEach(() => {
  contexts = [];
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
});

/**
 * Screenshots go to `screenshots/<viewport>/<name>.png`, which is gitignored:
 * they are evidence produced by a run, not a fixture checked against.
 */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `screenshots/${test.info().project.name}/${name}.png`,
    fullPage: false,
  });
}

/** Every board point is a 44 px target, whether or not it is tappable now. */
async function expectEveryPointBigEnough(page: Page): Promise<void> {
  const points = allPoints(page);
  await expect(points).toHaveCount(24);
  for (let i = 0; i < 24; i++) await expectTapTarget(points.nth(i));
}

/**
 * The element is showing all of its text.
 *
 * Both lines of the status bar are `truncate`d, and `toHaveText` reads
 * `textContent`, which is the full string whether or not the browser drew it.
 * The overflow is the only thing that knows: a clipped line is wider inside
 * than out.
 */
async function expectNotClipped(line: Locator): Promise<void> {
  await expect(line).toBeVisible();
  const overflow = await line.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, `"${await line.textContent()}" is cut off`).toBeLessThanOrEqual(0);
}

/**
 * Plays a script online, one ply at a time, over two seated pages. Who is to
 * act is derived from the script — the turn passes on every action except the
 * removal a mill earns (§4.5) — and confirmed by the page before every tap, so
 * nothing here waits on a clock. White starts, as always (§9).
 */
async function playOnline(
  seats: { W: Page; B: Page },
  actions: readonly Action[],
): Promise<void> {
  let turn: 'W' | 'B' = 'W';
  for (const [i, action] of actions.entries()) {
    const actor = seats[turn];
    await expect(statusHeadline(actor)).toHaveText('Your turn');
    await playActions(actor, [action]);
    const next = actions[i + 1];
    if (next !== undefined && next.type !== 'remove') {
      turn = turn === 'W' ? 'B' : 'W';
    }
  }
}

/** The placement half of the scripted game — everything before the first slide. */
const PLACEMENT = MILL_OUT_GAME.slice(
  0,
  MILL_OUT_GAME.findIndex((a) => a.type === 'move'),
);

test('home fits the viewport and its controls are big enough', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Morris' })).toBeVisible();
  await expectTapTarget(page.getByTestId('new-game'));
  await expectTapTarget(page.getByRole('link', { name: 'Play hot-seat' }));
  for (const choice of TIMER_CHOICES) {
    await expectTapTarget(page.getByTestId(`timer-${choice ?? 'none'}`));
  }
  await expectNoHorizontalScroll(page);
  await shot(page, 'home');
});

test('a game with a piece selected fits, and every point is a 44 px target', async ({
  page,
}) => {
  await page.goto('/local');
  await expectEveryPointBigEnough(page);

  // Play out placement, then pick up the piece the scripted game slides next, so
  // the shot shows a selection and its legal destinations (§6.2).
  await playActions(page, PLACEMENT);
  await expect(statusDetail(page)).toHaveText('Movement');
  await point(page, 22).click();
  await expect(point(page, 22)).toHaveAttribute('aria-pressed', 'true');
  await expect(point(page, 23)).toHaveAttribute('data-hint', 'true');

  await expectEveryPointBigEnough(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'selected');
});

test('removal mode fits and says what it wants', async ({ page }) => {
  await page.goto('/local');
  await playActions(page, OPENING);
  await expect(statusDetail(page)).toHaveText(
    'Mill! White removes a Black piece.',
  );
  await expectNotClipped(statusDetail(page));
  await expectEveryPointBigEnough(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'removal');
});

test('removal mode dims the pieces a mill protects', async ({ page }) => {
  await page.goto('/local');
  await playActions(page, PROTECTED_REMOVAL);
  await expect(statusDetail(page)).toHaveText(
    'Mill! White removes a Black piece.',
  );

  // §6.2's other removal state: Black holds four pieces, three of them locked in
  // a mill. Dimming has no attribute of its own — `Board.tsx` dims exactly the
  // opponent pieces a pending removal cannot take — so these two counts are the
  // two things on screen: one pulsing target, three dimmed pieces.
  await expect(page.locator('[data-occupant="B"]')).toHaveCount(4);
  await expect(page.locator('[data-removable]')).toHaveCount(1);
  await expect(point(page, PROTECTED_LOOSE)).toHaveAttribute(
    'data-removable',
    'true',
  );
  for (const protectedPoint of PROTECTED_MILL) {
    await expect(point(page, protectedPoint)).not.toHaveAttribute(
      'data-removable',
      /.*/,
    );
  }

  await expectEveryPointBigEnough(page);
  await expectNoHorizontalScroll(page);
  await shot(page, 'removal-protected');
});

test('the game-over banner fits over the finished board', async ({ page }) => {
  await page.goto('/local');
  await playActions(page, MILL_OUT_GAME);
  await expect(page.getByTestId('game-over')).toBeVisible();
  await expect(statusHeadline(page)).toHaveText('White wins — mill-out');
  await expectTapTarget(page.getByTestId('rematch'));
  await expectNoHorizontalScroll(page);
  await shot(page, 'game-over');
});

test('an online game fits its clocks and its share link round the board', async ({
  browser,
  page,
}) => {
  const white = page;
  // §5.3: a timer, so both clocks are drawn — inside the status-bar row, which
  // is the row the two truncated status lines are sharing.
  const { roomId, black } = await seatedRoom(
    browser,
    contexts,
    white,
    TIMER.fiveMinutes,
  );
  // §6.4: a third visitor, watching from the start.
  const visitor = await openRoom(browser, contexts, roomId);
  await expect(seatLabel(visitor)).toHaveText('Spectating');

  // A game with pieces on it, stopping one ply short of White's mill.
  await playOnline({ W: white, B: black }, OPENING.slice(0, -1));

  // §5.3: White is on the clock, Black is shown the allowance it will get back.
  await expect(white.getByTestId('clock-W')).toHaveAttribute(
    'data-active',
    'true',
  );
  await expect(white.getByTestId('clock-B')).toBeVisible();
  // §6.1: and the link is still in the bottom bar, a whole URL in a 288 px box.
  await white.getByTestId('share-toggle').click();
  await expect(shareLink(white)).toHaveValue(new RegExp(`/g/${roomId}$`));
  await expectTapTarget(shareLink(white));
  await expectTapTarget(white.getByTestId('copy'));
  await expectNotClipped(statusHeadline(white));
  await expectNotClipped(statusDetail(white));
  await expectNoHorizontalScroll(white);
  await shot(white, 'online');

  // The last ply is White's mill, which puts the longest sentence this UI can
  // produce on a spectator's second line — beside the clocks, in `text-xs`.
  await playOnline({ W: white, B: black }, OPENING.slice(-1));
  await expect(statusDetail(visitor)).toHaveText(
    'Mill! White removes a Black piece. · Spectating',
  );
  await expect(visitor.getByTestId('clock-W')).toHaveAttribute(
    'data-active',
    'true',
  );
  await expectNotClipped(statusHeadline(visitor));
  // The line this whole spec exists for. It overflowed a 360 px row by 22 px and
  // was drawn as "…removes a Black piece. · Spect" — §8.4's "cut-off text", in
  // the primary mode, invisible to every `toHaveText` in the suite because
  // `textContent` is the full string whether the browser drew it or not. The
  // status bar now wraps that line instead of truncating it.
  await expectNotClipped(statusDetail(visitor));
  await expectNoHorizontalScroll(visitor);
  await shot(visitor, 'spectating');
});

test('the online game-over banner fits, in the wording for a player', async ({
  browser,
  page,
}) => {
  const white = page;
  await seatedRoom(browser, contexts, white, TIMER.fiveMinutes);

  // §4.6: the quickest finished game there is. The banner is the online one —
  // a different component from hot-seat's, with the result told to the player
  // who is reading it.
  await white.getByTestId('resign').click();
  await expect(white.getByTestId('game-over')).toBeVisible();
  await expect(white.getByTestId('result-winner')).toHaveText('You lose.');
  await expect(white.getByTestId('result-reason')).toHaveText(
    'Black wins — resignation',
  );
  await expectNotClipped(statusHeadline(white));
  await expectTapTarget(white.getByTestId('rematch'));
  await expectTapTarget(white.getByTestId('new-game-link'));
  await expectNoHorizontalScroll(white);
  await shot(white, 'online-game-over');
});
