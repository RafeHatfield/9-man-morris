/**
 * Hot-seat, end to end (GDD §8.3, second e2e): a real game played through the UI
 * by tapping, to a finished result, then a rematch with the colours swapped.
 *
 * Runs at both mobile viewports (`playwright.config.ts`), and asserts §8.4's no
 * horizontal scroll at each of them.
 */

import { expect, test } from '@playwright/test';
import {
  counts,
  expectBoardInert,
  expectNoHorizontalScroll,
  expectTapTarget,
  playActions,
  point,
  statusDetail,
  statusHeadline,
  tapPoint,
} from './helpers';
import { FIRST_REMOVAL, OPENING, REST } from './scripted-game';

test.beforeEach(async ({ page }) => {
  await page.goto('/local');
});

test('hot-seat plays to a mill-out win, then rematches with the colours swapped', async ({
  page,
}) => {
  // A fresh game: White to move (§4.2), nine in hand each, Player 1 is White.
  await expect(statusHeadline(page)).toHaveText('White to play');
  await expect(statusDetail(page)).toHaveText('Placement');
  await expect(counts(page, 'W').hand).toHaveText('9');
  await expect(counts(page, 'B').hand).toHaveText('9');
  await expect(page.getByTestId('seat-P1')).toHaveText('White');
  await expect(page.getByTestId('seat-P2')).toHaveText('Black');
  await expect(page.getByTestId('game-over')).toHaveCount(0);
  await expectTapTarget(page.getByTestId('resign'));
  await expectTapTarget(page.getByTestId('draw'));
  await expectNoHorizontalScroll(page);

  // Placement, up to White's first mill: the board goes into removal mode and
  // offers the Black pieces that are not protected by a mill (§4.5, §6.2).
  await playActions(page, OPENING);
  await expect(statusDetail(page)).toHaveText(
    'Mill! White removes a Black piece.',
  );
  await expect(point(page, FIRST_REMOVAL)).toHaveAttribute(
    'data-removable',
    'true',
  );

  // The rest of the game, to White taking Black's seventh piece.
  await playActions(page, REST);

  // §6.3: a banner with the result and the reason.
  const banner = page.getByTestId('game-over');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('result-winner')).toHaveText('Player 1 wins.');
  await expect(page.getByTestId('result-reason')).toHaveText(
    'White wins — mill-out',
  );
  await expect(counts(page, 'B').board).toHaveText('2');
  await expect(counts(page, 'W').board).toHaveText('9');

  // A finished game takes no more taps (§6.2).
  await expectBoardInert(page);
  await expectNoHorizontalScroll(page);

  await expectTapTarget(page.getByTestId('rematch'));

  // §5.2: rematch swaps the colours. White still moves first (§4.2, §9), so the
  // swap shows in who is playing which colour, not in who starts.
  await page.getByTestId('rematch').click();

  await expect(page.getByTestId('game-over')).toHaveCount(0);
  await expect(statusHeadline(page)).toHaveText('White to play');
  await expect(statusDetail(page)).toHaveText('Placement');
  await expect(counts(page, 'W').hand).toHaveText('9');
  await expect(counts(page, 'B').hand).toHaveText('9');
  await expect(counts(page, 'W').board).toHaveText('0');
  await expect(counts(page, 'B').board).toHaveText('0');
  await expect(page.getByTestId('seat-P1')).toHaveText('Black');
  await expect(page.getByTestId('seat-P2')).toHaveText('White');

  // And the board takes taps again.
  await tapPoint(page, 0);
  await expect(point(page, 0)).toHaveAccessibleName('Point 0, White piece');
  await expect(statusHeadline(page)).toHaveText('Black to play');
  await expectNoHorizontalScroll(page);
});

test('an illegal tap is silently ignored', async ({ page }) => {
  await tapPoint(page, 5);
  await expect(statusHeadline(page)).toHaveText('Black to play');

  // Placing on an occupied point is not a legal action, so nothing happens: no
  // error, no change of turn (§6.2).
  await tapPoint(page, 5);
  await expect(statusHeadline(page)).toHaveText('Black to play');
  await expect(counts(page, 'B').hand).toHaveText('9');
  await expect(counts(page, 'W').board).toHaveText('1');
});

test('the player to move can resign', async ({ page }) => {
  await tapPoint(page, 5); // White places; Black is now to move.
  await page.getByTestId('resign').click();

  await expect(page.getByTestId('result-winner')).toHaveText('Player 1 wins.');
  await expect(page.getByTestId('result-reason')).toHaveText(
    'White wins — resignation',
  );
  await expect(page.getByTestId('resign')).toHaveCount(0);
  await expectBoardInert(page);
});

test('both players can agree a draw', async ({ page }) => {
  await tapPoint(page, 5);
  await page.getByTestId('draw').click();

  await expect(page.getByTestId('result-winner')).toHaveText('A draw.');
  await expect(page.getByTestId('result-reason')).toHaveText('Draw — agreed');
  await expect(page.getByTestId('draw')).toHaveCount(0);
  await expectBoardInert(page);
});
