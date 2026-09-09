/**
 * Driving the board from a Playwright test.
 *
 * Everything here talks to the page the way a player does: it finds the 24 points
 * by the `aria-label` GDD §6.5 requires ("Point 12, empty") and reads the chrome
 * by its test ids. Nothing here knows the rules — a spec hands it a list of
 * actions and asserts what the page then says. Most helpers take a `Page`, so
 * the four online spec files use them against two or three pages at once; the
 * ones that open a context or measure a control take a `Browser` or a `Locator`
 * instead.
 */

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import type { Action } from '../src/lib/engine';
import { seatStorageKey, type StoredSeat } from '../src/lib/client/seat';

/** The tap target for a board point, found by its accessible name (§6.5). */
export function point(page: Page, index: number): Locator {
  return page.getByRole('button', { name: new RegExp(`^Point ${index}, `) });
}

/** Every board point, whether or not it is currently tappable. */
export function allPoints(page: Page): Locator {
  return page.getByRole('button', { name: /^Point \d+, / });
}

/** Line one of the status bar: whose turn, or the result (§6.1). */
export function statusHeadline(page: Page): Locator {
  return page.getByTestId('status-headline');
}

/** Line two: the pending-removal prompt, or the phase (§6.1). */
export function statusDetail(page: Page): Locator {
  return page.getByTestId('status-detail');
}

/** Pieces in hand and on the board for one side (§6.1). */
export function counts(
  page: Page,
  player: 'W' | 'B',
): { hand: Locator; board: Locator } {
  return {
    hand: page.getByTestId(`hand-${player}`),
    board: page.getByTestId(`board-${player}`),
  };
}

/** Taps one point. Illegal taps are expected to do nothing (§6.2). */
export async function tapPoint(page: Page, index: number): Promise<void> {
  await point(page, index).click();
}

/**
 * Plays a list of engine actions through the UI, as taps. A placement or a
 * removal is one tap; a move is two — the piece, then the destination — and the
 * selection is asserted in between rather than waited for, so the sequence is
 * driven by what the page shows and never by a timer.
 */
export async function playActions(
  page: Page,
  actions: readonly Action[],
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case 'place':
      case 'remove':
        await tapPoint(page, action.point);
        break;
      case 'move': {
        const from = point(page, action.from);
        await from.click();
        await expect(from).toHaveAttribute('aria-pressed', 'true');
        await tapPoint(page, action.to);
        break;
      }
      default:
        throw new Error(`not a board action: ${action.type}`);
    }
  }
}

/**
 * The board accepts no taps — the game is over, it is not this viewer's turn, or
 * the viewer is a spectator (§6.2, §6.4): every point button is disabled.
 */
export async function expectBoardInert(page: Page): Promise<void> {
  await expect(allPoints(page)).toHaveCount(24);
  await expect(
    page.getByRole('button', { name: /^Point \d+, /, disabled: false }),
  ).toHaveCount(0);
}

/**
 * GDD §6.2: a control is at least 44 × 44 px as rendered. The board's points are
 * measured from `geometry.test.ts`; this is for the buttons a page adds round it.
 */
export async function expectTapTarget(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  if (box === null) throw new Error('control has no bounding box');
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

/** GDD §8.4: no horizontal scroll at the viewport, at either mobile width. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.documentElement;
        return el.scrollWidth - el.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(0);
}

// — online mode (two browser contexts, GDD §8.3) ————————————————————————

/**
 * A second (or third) browser context at the project's viewport, so a two-player
 * spec runs at 360×740 and 390×844 like everything else.
 */
export async function newViewportContext(
  browser: Browser,
): Promise<BrowserContext> {
  const { viewport, hasTouch, isMobile } = test.info().project.use;
  return browser.newContext({ viewport, hasTouch, isMobile });
}

/**
 * Puts a seat token in a context's `localStorage` exactly as the client stores it
 * (`src/lib/client/seat.ts`), so a page opens already seated — used where a room
 * is made through the API to get a timer or a position the UI cannot.
 */
export async function seedSeat(
  context: BrowserContext,
  roomId: string,
  seat: StoredSeat,
): Promise<void> {
  await context.addInitScript(
    ([key, value]: [string, string]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // about:blank has no usable storage; the real page will get it.
      }
    },
    [seatStorageKey(roomId), JSON.stringify(seat)] as [string, string],
  );
}

/** The link the share panel is offering (§5.1). */
export function shareLink(page: Page): Locator {
  return page.getByTestId('share-link');
}

/**
 * Writes a seat into an open page's storage **once**, unlike {@link seedSeat},
 * which re-seeds on every navigation: a later reload sees what the app left.
 */
export async function putSeat(
  page: Page,
  roomId: string,
  seat: StoredSeat,
): Promise<void> {
  await page.evaluate(
    ([key, value]: [string, string]) => window.localStorage.setItem(key, value),
    [seatStorageKey(roomId), JSON.stringify(seat)] as [string, string],
  );
}

/** What this browser has stored for the room. */
export async function storedSeat(
  page: Page,
  roomId: string,
): Promise<StoredSeat | null> {
  return page.evaluate((key: string) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as StoredSeat);
  }, seatStorageKey(roomId));
}

/** "You play White" / "You play Black" / "Spectating" (§6.4). */
export function seatLabel(page: Page): Locator {
  return page.getByTestId('you');
}

/**
 * Backgrounds a tab, or brings it back, as `visibilitychange` reports it — the
 * only thing §7.3's "stops when the tab is hidden" is driven from. The property
 * is redefined rather than the window really hidden: a headless browser has no
 * window manager, and `page.bringToFront()` cannot background the only page.
 */
export async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((state: string) => {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden ? 'hidden' : 'visible');
}

/**
 * Counts the room reads one page makes from now on, and returns the count.
 * `GET /api/game/[id]` is the only request §7.3's polling makes and the only one
 * the client ever makes without being tapped, so this is what "is it polling"
 * means from outside the page. The mutating endpoints all live a segment deeper,
 * so the path shape tells them apart without reading a body.
 */
export function countRoomReads(page: Page): () => number {
  let reads = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      /^\/api\/game\/[^/]+$/.test(new URL(request.url()).pathname)
    ) {
      reads += 1;
    }
  });
  return () => reads;
}

// — rooms the online specs are played in ————————————————————————————————

/**
 * A finished game polls every 5 s, not every 1.5 s (§7.3), so the rematch
 * handshake — the one exchange that happens after the result — needs longer
 * than Playwright's default 5 s to cross between the two clients.
 */
export const AFTER_GAME_OVER = { timeout: 20_000 };

/**
 * The same 5 s, earned the other way: a client whose own turn it is polls
 * slowly too (§7.3, "nothing can change without you"), so anything that does
 * change without it takes up to one idle interval to arrive: an out-of-band
 * write, or the two things §4.6 lets the *other* player do out of turn.
 */
export const ON_THE_IDLE_POLL = { timeout: 20_000 };

/** The turn-timer choices of §5.3 these specs use, as the home page tags them. */
export const TIMER = {
  none: 'timer-none',
  fiveMinutes: 'timer-300000',
} as const;

/** Creates a room through the UI and returns its id. The creator is White. */
export async function createRoom(page: Page, timer: string): Promise<string> {
  await page.goto('/');
  await expectNoHorizontalScroll(page);
  await page.getByTestId(timer).click();
  await expect(page.getByTestId(timer)).toHaveAttribute('data-checked', 'true');
  await page.getByTestId('new-game').click();

  await page.waitForURL(/\/g\/[A-Z2-9]{8}$/);
  await expect(seatLabel(page)).toHaveText('You play White');
  return page.url().split('/g/')[1];
}

/**
 * Opens the room in its own context — the second player, or a visitor. The
 * context is pushed onto the spec's own list, which closes it afterwards.
 */
export async function openRoom(
  browser: Browser,
  contexts: BrowserContext[],
  roomId: string,
): Promise<Page> {
  const context = await newViewportContext(browser);
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`/g/${roomId}`);
  return page;
}

/** A room with both seats filled: the creator, and the first other visitor. */
export async function seatedRoom(
  browser: Browser,
  contexts: BrowserContext[],
  white: Page,
  timer: string = TIMER.none,
): Promise<{ roomId: string; black: Page }> {
  const roomId = await createRoom(white, timer);
  const black = await openRoom(browser, contexts, roomId);
  await expect(seatLabel(black)).toHaveText('You play Black');
  // Sampled, not waited for. The answer to `/join` carries the room this player
  // has just changed, so the render that first says "You play Black" is already
  // the render of a room with two seats in it. Waiting would be satisfied by the
  // next poll 1.5 s later — the very thing this line rules out.
  expect(await statusHeadline(black).textContent()).toBe('Waiting for White…');
  // White's page learns of the join by polling; the share panel has done its job.
  await expect(white.getByTestId('share')).toHaveCount(0);
  return { roomId, black };
}
