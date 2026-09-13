/**
 * The races that cost a player something (GDD §7.3).
 *
 * Every spec here is one moment where two things happen at once — a tap and an
 * opponent's move, a tap and a rematch — and the rule under all of them is
 * §7.3's: **the server is the only authority, and the client adopts what comes
 * back.** A refusal carries the room as the server really has it, so a rejected
 * tap is also a resync, and nothing may keep state the server contradicted. The
 * poll gaps are deterministic, not waited for: a page's reads are cut off, or
 * its tab is hidden, which stops its polling (§7.3).
 */

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import type { CreateGameResponse, JoinResponse } from '../src/lib/api/types';
import {
  counts,
  expectBoardInert,
  newViewportContext,
  playActions,
  point,
  putSeat,
  seatLabel,
  seatedRoom,
  seedSeat,
  setTabHidden,
  statusHeadline,
  storedSeat,
} from './helpers';

let contexts: BrowserContext[] = [];

test.beforeEach(() => {
  contexts = [];
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
});

/** A room with both seats claimed through the API, so a spec holds both tokens. */
async function apiRoom(
  request: APIRequestContext,
  timerMs: number | null,
): Promise<{ roomId: string; white: string; black: string }> {
  const created = await request.post('/api/game', { data: { timerMs } });
  expect(created.status()).toBe(200);
  const { roomId, token: white }: CreateGameResponse = await created.json();
  const joined = await request.post(`/api/game/${roomId}/join`);
  expect(joined.status()).toBe(200);
  const { token: black }: JoinResponse = await joined.json();
  return { roomId, white, black };
}

/** Ends the game and rematches out of band: the room is then on game 2, with the
 *  colours swapped (§5.4) — a game a frozen page has never seen. */
async function rematchOutOfBand(
  request: APIRequestContext,
  roomId: string,
  white: string,
  black: string,
): Promise<void> {
  const before = await request.get(`/api/game/${roomId}`);
  const { version } = await before.json();
  const resigned = await request.post(`/api/game/${roomId}/action`, {
    data: { token: white, action: { type: 'resign' }, expectedVersion: version },
  });
  expect(resigned.status()).toBe(200);
  for (const token of [white, black]) {
    const accepted = await request.post(`/api/game/${roomId}/rematch`, {
      data: { token },
    });
    expect(accepted.status()).toBe(200);
  }
  const now = await request.get(`/api/game/${roomId}`);
  expect((await now.json()).gameNumber).toBe(2);
}

/** This page will never learn anything again: its reads are cut off. */
async function freezeReads(page: Page): Promise<void> {
  await page.route('**/api/game/*', async (route) => {
    if (route.request().method() === 'GET') await route.abort();
    else await route.continue();
  });
}

test('a resignation is not lost to a move that lands in the same moment', async ({
  browser,
  page,
}) => {
  const white = page;
  const { black } = await seatedRoom(browser, contexts, white);

  // Freeze White's page at the version it holds: its polling GET never returns,
  // so it cannot learn that Black has replied, though its own actions still go
  // out. The ordinary 1.5 s gap after an opponent move, made deterministic.
  await freezeReads(white);

  await playActions(white, [{ type: 'place', point: 5 }]);
  await expect(statusHeadline(white)).toHaveText('Waiting for Black…');

  // Black replies. The server has moved on; White's board has not.
  await playActions(black, [{ type: 'place', point: 19 }]);
  await expect(statusHeadline(black)).toHaveText('Waiting for White…');
  await expect(statusHeadline(white)).toHaveText('Waiting for Black…');

  // §4.6: a resignation is legal at the version the server actually holds, so it
  // must not be swallowed by the one this client drew its board from: it is
  // re-pinned to the version the 409 names and re-sent (`resignGame`).
  await white.getByTestId('resign').click();
  await expect(statusHeadline(white)).toHaveText('Black wins — resignation');
  await expect(white.getByTestId('result-winner')).toHaveText('You lose.');
  await expect(statusHeadline(black)).toHaveText('Black wins — resignation');
});

test('a seat the server does not recognise is given up', async ({
  browser,
  page,
}) => {
  const white = page;
  const { roomId } = await seatedRoom(browser, contexts, white);

  // A token that was never issued — hand-edited, or long expired — for a room
  // whose two seats are both really taken. Written into storage the way a
  // tampering user would, so a later reload sees whatever the app leaves.
  const impostor = await newViewportContext(browser);
  contexts.push(impostor);
  const stale: Page = await impostor.newPage();
  await stale.goto(`/g/${roomId}`);
  await expect(seatLabel(stale)).toHaveText('Spectating');
  await putSeat(stale, roomId, {
    token: 'not-a-token-this-server-ever-issued',
    colour: 'W',
    gameNumber: 1,
  });
  await stale.reload();

  // Nothing on the wire says whether a token holds a seat, so it is believed
  // until the server refuses it…
  await expect(seatLabel(stale)).toHaveText('You play White');

  // …and the first refusal settles it (§7.3): one tap, and it is a visitor.
  await playActions(stale, [{ type: 'place', point: 5 }]);
  await expect(seatLabel(stale)).toHaveText('Spectating');
  await expectBoardInert(stale);

  // The refused token is dropped: a reload does not restore the same seat.
  expect(await storedSeat(stale, roomId)).toBeNull();
  await stale.reload();
  await expect(seatLabel(stale)).toHaveText('Spectating');

  // And the real player was never touched by any of it.
  await expect(point(white, 5)).toHaveAccessibleName('Point 5, empty');
  await expect(seatLabel(white)).toHaveText('You play White');
  await expect(statusHeadline(white)).toHaveText('Your turn');
});

test('a claim refused because the clock is now ours does not cost the seat', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const {
    roomId,
    white: whiteToken,
    black: blackToken,
  } = await apiRoom(request, 2_000);

  // This page holds Black in game 1, where White is on the clock.
  await seedSeat(page.context(), roomId, {
    token: blackToken,
    colour: 'B',
    gameNumber: 1,
  });
  await page.goto(`/g/${roomId}`);
  await expect(seatLabel(page)).toHaveText('You play Black');

  await freezeReads(page);
  // The clock runs out on the view it holds, so it offers the claim (§5.3).
  await expect(page.getByTestId('claim')).toBeVisible({ timeout: 20_000 });

  // Out of band, game 2 starts — and this token now plays White, so it is the
  // player on the clock. `/claim-timeout` answers "the clock is yours", a 403
  // only a real seat holder can earn.
  await rematchOutOfBand(request, roomId, whiteToken, blackToken);
  await page.getByTestId('claim').click();

  // §5.1: a lost token is a lost seat, so that refusal must not be read as one.
  // `yourOwnClock` is not `notAPlayer`, and only the latter is read as seat loss.
  // Nothing else asserts that sentence gate end to end.
  await expect(seatLabel(page)).toHaveText('You play White');
  await expect(statusHeadline(page)).toHaveText('Your turn');
  expect(await storedSeat(page, roomId)).not.toBeNull();
});

test('a reply about a different room is not adopted', async ({
  browser,
  page,
  request,
}) => {
  const white = page;
  const { roomId, black } = await seatedRoom(browser, contexts, white);
  await playActions(white, [{ type: 'place', point: 5 }]);
  await expect(statusHeadline(white)).toHaveText('Waiting for Black…');

  // Another room, genuinely this server's — a stray reply from a proxy or a
  // misrouted edge. It is played on until it out-versions ours, which is what
  // makes adopting it unrecoverable rather than merely wrong: a version only
  // climbs, so a higher one from elsewhere makes `adoptRoom` reject every
  // genuine poll that follows.
  const other = await apiRoom(request, null);
  for (const [i, spot] of [0, 1, 2, 3, 4, 5].entries()) {
    const before = await (await request.get(`/api/game/${other.roomId}`)).json();
    const played = await request.post(`/api/game/${other.roomId}/action`, {
      data: {
        token: i % 2 === 0 ? other.white : other.black,
        action: { type: 'place', point: spot },
        expectedVersion: before.version,
      },
    });
    expect(played.status()).toBe(200);
  }
  const strangersRoom = await (
    await request.get(`/api/game/${other.roomId}`)
  ).json();
  const ours = await (await request.get(`/api/game/${roomId}`)).json();
  expect(strangersRoom.id).not.toBe(ours.id);
  expect(strangersRoom.version).toBeGreaterThan(ours.version);

  let spoiled = false;
  await white.route('**/api/game/*', async (route) => {
    if (route.request().method() === 'GET' && !spoiled) {
      spoiled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(strangersRoom),
      });
      return;
    }
    await route.continue();
  });

  // The board is untouched — the stranger's room has three White pieces to our
  // one — and the polling never stopped, so the next real reply lands.
  await playActions(black, [{ type: 'place', point: 19 }]);
  await expect(statusHeadline(white)).toHaveText('Your turn', {
    timeout: 20_000,
  });
  await expect(counts(white, 'W').board).toHaveText('1');
  await expect(point(white, 19)).toHaveAccessibleName('Point 19, Black piece');
});

test('a draw offer that arrives during the same game is not accepted unseen', async ({
  page,
  request,
}) => {
  const {
    roomId,
    white: whiteToken,
    black: blackToken,
  } = await apiRoom(request, null);
  await seedSeat(page.context(), roomId, {
    token: whiteToken,
    colour: 'W',
    gameNumber: 1,
  });
  await page.goto(`/g/${roomId}`);
  await expect(page.getByTestId('draw')).toHaveText('Offer draw');

  // One game throughout, so both taps carry the same `gameNumber` and the server
  // cannot tell them apart on that alone. What the player *read* is the only
  // thing that can, and it travels with the tap (`offerDraw`'s `accepting`). A
  // hidden tab stops polling (§7.3): the widest version of the poll gap.
  await setTabHidden(page, true);

  const offered = await request.post(`/api/game/${roomId}/draw`, {
    data: { token: blackToken },
  });
  expect(offered.status()).toBe(200);

  // The button still says "Offer draw", and §4.6's "if the other accepts" is
  // about consent: this tap must not be read as the acceptance it would now be.
  await page.getByTestId('draw').click();

  const after = await request.get(`/api/game/${roomId}`);
  const room = await after.json();
  expect(room.gameNumber).toBe(1);
  expect(room.game.result).toBeNull();
  expect(room.drawOffer).toEqual({ W: false, B: true });

  // And the refusal carried the room, so the page has caught up.
  await expect(page.getByTestId('draw')).toHaveText('Accept draw');
});
