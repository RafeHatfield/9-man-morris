import { describe, expect, it } from 'vitest';

import { POLL_ACTIVE_MS, POLL_IDLE_MS, pollIntervalMs } from './polling';

const LIVE = { hidden: false, missing: false, live: true, yourTurn: false };

describe('pollIntervalMs', () => {
  it('is 1.5 s while the game is live and it is not your turn (GDD §7.3)', () => {
    expect(pollIntervalMs(LIVE)).toBe(POLL_ACTIVE_MS);
    expect(POLL_ACTIVE_MS).toBe(1_500);
  });

  it('is 5 s on your own turn: nothing can change without you', () => {
    expect(pollIntervalMs({ ...LIVE, yourTurn: true })).toBe(POLL_IDLE_MS);
    expect(POLL_IDLE_MS).toBe(5_000);
  });

  it('is 5 s once the game is over — a rematch is all that is left', () => {
    expect(pollIntervalMs({ ...LIVE, live: false })).toBe(POLL_IDLE_MS);
  });

  it('stops while the tab is hidden', () => {
    expect(pollIntervalMs({ ...LIVE, hidden: true })).toBeNull();
    expect(pollIntervalMs({ ...LIVE, hidden: true, yourTurn: true })).toBeNull();
  });

  it('stops for a room that is not there', () => {
    expect(pollIntervalMs({ ...LIVE, missing: true })).toBeNull();
  });
});
