import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PLAYER_TOKEN_BYTES,
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
  newPlayerToken,
  newRoomId,
} from './ids';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Drives the next `crypto.getRandomValues` calls from a script of fillers, and
 * reports how many draws were taken. Deterministic: no sampling, no luck.
 */
function withBytes(fill: (draw: number, bytes: Uint8Array) => void): {
  draws: () => number;
  requested: () => number[];
} {
  let draws = 0;
  const requested: number[] = [];
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
    const bytes = array as unknown as Uint8Array;
    requested.push(bytes.length);
    fill(draws++, bytes);
    return array;
  });
  return { draws: () => draws, requested: () => requested };
}

describe('newRoomId', () => {
  it('is 8 characters long', () => {
    for (let i = 0; i < 100; i++) {
      expect(newRoomId()).toHaveLength(ROOM_ID_LENGTH);
    }
    expect(ROOM_ID_LENGTH).toBe(8);
  });

  it('uses an alphabet without ambiguous characters', () => {
    for (const ambiguous of ['0', 'O', '1', 'l', 'I']) {
      expect(ROOM_ID_ALPHABET).not.toContain(ambiguous);
    }
    expect(new Set(ROOM_ID_ALPHABET).size).toBe(ROOM_ID_ALPHABET.length);
    expect(ROOM_ID_ALPHABET).toBe(ROOM_ID_ALPHABET.toUpperCase());
    // The alphabet itself, character for character, for the reason
    // `UPDATE_SCRIPT` is pinned that way: no edit to it may be silent. The
    // properties above are all *absences* — they say nothing about what is in it,
    // so `'2345678/ABCDEFGHJKMNPQRSTVWXYZ'` satisfies every one of them, and a
    // room id containing `/` breaks the share link, because `/g/AB/D2345` does
    // not route.
    expect(ROOM_ID_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTVWXYZ');
  });

  it('only ever emits characters from that alphabet', () => {
    for (let i = 0; i < 500; i++) {
      for (const char of newRoomId()) {
        expect(ROOM_ID_ALPHABET).toContain(char);
      }
    }
  });

  /**
   * The bias property, asserted directly rather than sampled for collisions: a
   * zero-tolerance collision test over 30^8 is a coin flip that fails ~1 run in
   * 3,300 with a message that reads like a real bias bug. This walks every byte
   * value the generator can ever see and pins exactly what each one does. (The
   * sampled property is kept too, below, with the one-collision tolerance that
   * takes the flake out of it.)
   */
  it('maps every byte uniformly and discards the ones that would bias', () => {
    const symbolFor = new Map<number, string>();
    const discarded: number[] = [];

    for (let byte = 0; byte <= 255; byte++) {
      // Draw 0 is all `byte`; any further draw is all zeroes, so a second draw
      // is proof that the whole first draw was thrown away.
      const probe = withBytes((draw, bytes) => bytes.fill(draw === 0 ? byte : 0));
      const id = newRoomId();
      const draws = probe.draws();
      // Every draw asks for exactly the characters still missing.
      expect(probe.requested()[0]).toBe(ROOM_ID_LENGTH);
      vi.restoreAllMocks();

      if (draws === 1) {
        symbolFor.set(byte, id[0]);
        expect(id).toBe(id[0].repeat(ROOM_ID_LENGTH));
      } else {
        discarded.push(byte);
        expect(id).toBe(ROOM_ID_ALPHABET[0].repeat(ROOM_ID_LENGTH));
      }
    }

    // 240 is the largest multiple of 30 that fits in a byte; 240–255 are the
    // values that would make the low symbols more likely than the high ones.
    expect(discarded).toEqual([
      240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254,
      255,
    ]);
    expect(symbolFor.size).toBe(240);

    // Uniform: every symbol is reachable, and by the same number of bytes.
    const perSymbol = new Map<string, number>();
    for (const symbol of symbolFor.values()) {
      perSymbol.set(symbol, (perSymbol.get(symbol) ?? 0) + 1);
    }
    expect(perSymbol.size).toBe(ROOM_ID_ALPHABET.length);
    expect([...new Set(perSymbol.values())]).toEqual([
      240 / ROOM_ID_ALPHABET.length,
    ]);
  });

  /**
   * The twin of `newPlayerToken`'s byte-faithfulness test, and the hole this
   * describe had: every case above fills the draw *uniformly* (`bytes.fill`), so
   * none of them can tell `ROOM_ID_ALPHABET[byte % 30]` from
   * `ROOM_ID_ALPHABET[bytes[0] % 30]`. That mutant reads one byte per draw and
   * collapses the space from 30^8 to a few thousand ids — measured: 2,618
   * distinct in 50,000 draws, of the shape `RRRR8888` — while passing every
   * other assertion in this file. A non-uniform fill is what distinguishes them.
   */
  it('consumes every byte of the draw, in order', () => {
    withBytes((_draw, bytes) => bytes.forEach((_, i) => (bytes[i] = i)));
    expect(newRoomId()).toBe(ROOM_ID_ALPHABET.slice(0, ROOM_ID_LENGTH));
  });

  it('gives every character position its own byte', () => {
    // The same property from the other side, one position at a time: a draw of
    // zeroes with a single 1 in it must move exactly the character that byte
    // feeds and nothing else. Kills reading a fixed byte, reading the draw
    // backwards, and any reuse of one byte across positions — which is what
    // `30^8` means and what the collision resistance in `ids.ts` rests on.
    for (let position = 0; position < ROOM_ID_LENGTH; position++) {
      withBytes((_draw, bytes) => {
        bytes.fill(0);
        bytes[position] = 1;
      });
      const expected = Array.from(
        { length: ROOM_ID_LENGTH },
        (_, i) => ROOM_ID_ALPHABET[i === position ? 1 : 0],
      ).join('');

      expect(newRoomId()).toBe(expected);
      vi.restoreAllMocks();
    }
  });

  it('does not repeat over a large sample', () => {
    // The property the deleted collision test carried, kept without the coin
    // flip that got it deleted. 20,000 draws from 30^8 ≈ 6.56e11 expect 3.0e-4
    // collisions, so demanding *zero* fails a legitimate run about 1 time in
    // 3,300; two collisions is ~5e-8, so a tolerance of one is the same claim
    // with the flake removed. It is nowhere near loose enough to let a shrunken
    // space through: the `bytes[0]` mutant returns ~2,500 distinct ids here.
    const sample = 20_000;
    const ids = new Set<string>();
    for (let i = 0; i < sample; i++) ids.add(newRoomId());
    expect(ids.size).toBeGreaterThanOrEqual(sample - 1);
  });
});

describe('newPlayerToken', () => {
  it('is 32 lowercase hex characters, 16 bytes of entropy', () => {
    expect(PLAYER_TOKEN_BYTES).toBe(16);
    for (let i = 0; i < 100; i++) {
      const token = newPlayerToken();
      expect(token).toHaveLength(PLAYER_TOKEN_BYTES * 2);
      expect(token).toMatch(/^[0-9a-f]+$/);
    }
  });

  it('comes from the crypto source, one draw of exactly that many bytes', () => {
    const probe = withBytes((_draw, bytes) => bytes.fill(0));
    const token = newPlayerToken();

    // Not `Math.random`, and not a short draw padded out to length.
    expect(probe.draws()).toBe(1);
    expect(probe.requested()).toEqual([PLAYER_TOKEN_BYTES]);
    expect(token).toBe('00'.repeat(PLAYER_TOKEN_BYTES));
  });

  it('encodes every byte faithfully, low bytes zero-padded', () => {
    withBytes((_draw, bytes) => bytes.forEach((_, i) => (bytes[i] = i)));
    // Without the padStart, byte 0x00 would encode as "0" and the token would
    // be short and ambiguous.
    expect(newPlayerToken()).toBe('000102030405060708090a0b0c0d0e0f');
    vi.restoreAllMocks();

    withBytes((_draw, bytes) => bytes.fill(255));
    expect(newPlayerToken()).toBe('ff'.repeat(PLAYER_TOKEN_BYTES));
  });

  it('does not repeat over a large sample', () => {
    // Unlike the room id, this is not a coin flip: a collision among 20,000
    // draws from 2^128 has probability ~6e-31.
    const sample = 20_000;
    const tokens = new Set<string>();
    for (let i = 0; i < sample; i++) tokens.add(newPlayerToken());
    expect(tokens.size).toBe(sample);
  });
});
