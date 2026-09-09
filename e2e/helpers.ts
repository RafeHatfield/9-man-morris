/**
 * Driving the board from a Playwright test.
 *
 * Everything here talks to the page the way a player does: it finds the 24
 * points by the `aria-label` GDD §6.5 requires ("Point 12, empty") and reads the
 * chrome by its test ids. Nothing here knows the rules — a spec hands it a list
 * of actions and asserts what the page then says.
 *
 * Every helper takes a `Page`, so the online spec (two browser contexts) can use
 * the same ones against two pages at once.
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
 * Plays a list of engine actions through the UI, as taps.
 *
 * A placement or a removal is one tap; a move is two — the piece, then the
 * destination — and the selection is asserted in between rather than waited for,
 * so the sequence is driven by what the page shows and never by a timer.
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
 * The board accepts no taps: the game is over, it is not this viewer's turn, or
 * the viewer is a spectator (§6.2, §6.4). Every point button is disabled.
 */
export async function expectBoardInert(page: Page): Promise<void> {
  await expect(allPoints(page)).toHaveCount(24);
  await expect(
    page.getByRole('button', { name: /^Point \d+, /, disabled: false }),
  ).toHaveCount(0);
}

/**
 * GDD §6.2: a control is at least 44 × 44 px as rendered. The board's points are
 * measured from the layout constants in `geometry.test.ts`; this is for the
 * buttons a page adds around it.
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
 * A second (or third) browser context at the same viewport as the project under
 * test, so a two-player spec runs at 360×740 and 390×844 like everything else.
 */
export async function newViewportContext(
  browser: Browser,
): Promise<BrowserContext> {
  const { viewport, hasTouch, isMobile } = test.info().project.use;
  return browser.newContext({ viewport, hasTouch, isMobile });
}

/**
 * Puts a seat token in a context's `localStorage`, exactly as the client stores
 * it (`src/lib/client/seat.ts`), so a page opens already seated. Used by the
 * timeout spec, which creates its room through the API to get a timer the UI
 * does not offer.
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
 * which re-seeds on every navigation. Use this where a later reload has to see
 * what the app itself left behind.
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

/** What this browser has stored for the room, as the client stores it. */
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
