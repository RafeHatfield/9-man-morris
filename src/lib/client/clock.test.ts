import { describe, expect, it } from 'vitest';

import {
  CLAIM_GRACE_MS,
  URGENT_MS,
  canClaim,
  formatClock,
  isUrgent,
  remainingMs,
  serverNow,
  timerLabel,
} from './clock';

describe('serverNow', () => {
  it('corrects the client clock by the measured skew', () => {
    expect(serverNow(1_000, 250)).toBe(1_250);
    expect(serverNow(1_000, -250)).toBe(750);
  });
});

describe('remainingMs', () => {
  it('counts down from the start of the turn', () => {
    expect(remainingMs(1_000, 60_000, 1_000)).toBe(60_000);
    expect(remainingMs(1_000, 60_000, 31_000)).toBe(30_000);
  });

  it('goes negative once the clock has run out — there is no auto-forfeit', () => {
    expect(remainingMs(1_000, 60_000, 62_000)).toBe(-1_000);
  });
});

describe('canClaim', () => {
  it('waits for the grace margin, so the server cannot refuse the claim', () => {
    expect(canClaim(1)).toBe(false);
    expect(canClaim(0)).toBe(false);
    expect(canClaim(-CLAIM_GRACE_MS + 1)).toBe(false);
    expect(canClaim(-CLAIM_GRACE_MS)).toBe(true);
    expect(canClaim(-5_000)).toBe(true);
  });
});

describe('isUrgent', () => {
  it('is the last ten seconds (GDD §5.3)', () => {
    expect(isUrgent(URGENT_MS + 1)).toBe(false);
    expect(isUrgent(URGENT_MS)).toBe(false);
    expect(isUrgent(URGENT_MS - 1)).toBe(true);
    expect(isUrgent(-1)).toBe(true);
  });
});

describe('formatClock', () => {
  it('is M:SS under an hour', () => {
    expect(formatClock(300_000)).toBe('5:00');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(9_000)).toBe('0:09');
  });

  it('rounds up, so 0:00 means the clock is really spent', () => {
    expect(formatClock(9_500)).toBe('0:10');
    expect(formatClock(1)).toBe('0:01');
    expect(formatClock(0)).toBe('0:00');
  });

  it('never shows a negative clock', () => {
    expect(formatClock(-5_000)).toBe('0:00');
  });

  it('is H:MM:SS from an hour up, for the one-day timer', () => {
    expect(formatClock(86_400_000)).toBe('24:00:00');
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(3_661_000)).toBe('1:01:01');
  });
});

describe('timerLabel', () => {
  it('names the four choices of GDD §5.3', () => {
    expect(timerLabel(null)).toBe('None');
    expect(timerLabel(60_000)).toBe('1 min');
    expect(timerLabel(300_000)).toBe('5 min');
    expect(timerLabel(86_400_000)).toBe('1 day');
  });

  it('falls back to a clock for the test-only timers', () => {
    expect(timerLabel(5_000)).toBe('0:05');
  });
});
