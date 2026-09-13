import { describe, expect, it } from 'vitest';
import { SEATS, colourOf, seatOf } from './seats';

describe('hot-seat colours', () => {
  it('gives Player 1 White in the first game', () => {
    expect(colourOf('P1', 1)).toBe('W');
    expect(colourOf('P2', 1)).toBe('B');
  });

  it('swaps the colours on each rematch', () => {
    expect(colourOf('P1', 2)).toBe('B');
    expect(colourOf('P2', 2)).toBe('W');
    expect(colourOf('P1', 3)).toBe('W');
    expect(colourOf('P2', 3)).toBe('B');
  });

  it('never gives both seats the same colour', () => {
    for (let game = 1; game <= 6; game++) {
      expect(colourOf('P1', game)).not.toBe(colourOf('P2', game));
    }
  });

  it('inverts: seatOf(colourOf(seat)) is the seat', () => {
    for (let game = 1; game <= 6; game++) {
      for (const seat of SEATS) {
        expect(seatOf(colourOf(seat, game), game)).toBe(seat);
      }
    }
  });
});
