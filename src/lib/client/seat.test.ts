import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  colourFor,
  readSeat,
  seatStorageKey,
  storageAvailable,
  writeSeat,
  type StoredSeat,
} from './seat';

/** The parts of `Storage` this module uses, plus a switch to make writes throw. */
function fakeStorage(options: { throwOnWrite?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => {
      if (options.throwOnWrite) throw new Error('QuotaExceededError');
      map.set(k, v);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

const WHITE: StoredSeat = { token: 'abc', colour: 'W', gameNumber: 1 };

describe('colourFor', () => {
  it('is the stored colour in the game it was stored for', () => {
    expect(colourFor(WHITE, 1)).toBe('W');
  });

  it('swaps on each rematch (GDD §5.4)', () => {
    expect(colourFor(WHITE, 2)).toBe('B');
    expect(colourFor(WHITE, 3)).toBe('W');
    expect(colourFor(WHITE, 4)).toBe('B');
    expect(colourFor({ ...WHITE, colour: 'B' }, 2)).toBe('W');
  });

  it('is right even if the stored game is ahead of the room', () => {
    expect(colourFor({ ...WHITE, gameNumber: 4 }, 3)).toBe('B');
  });
});

describe('storageAvailable', () => {
  it('is false with no storage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(storageAvailable()).toBe(false);
  });

  it('is false when the browser has one but refuses to write (private mode)', () => {
    vi.stubGlobal('localStorage', fakeStorage({ throwOnWrite: true }));
    expect(storageAvailable()).toBe(false);
  });

  it('leaves nothing behind when it probes', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    expect(storageAvailable()).toBe(true);
    expect(store.length).toBe(0);
  });
});

describe('readSeat / writeSeat', () => {
  it('round-trips a seat, keyed by room', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(writeSeat('ROOM1', WHITE)).toBe(true);
    expect(readSeat('ROOM1')).toEqual(WHITE);
    expect(readSeat('ROOM2')).toBeNull();
  });

  it('reports failure rather than throwing when there is no storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(writeSeat('ROOM1', WHITE)).toBe(false);
    expect(readSeat('ROOM1')).toBeNull();
  });

  it('reports failure rather than throwing when the write is refused', () => {
    vi.stubGlobal('localStorage', fakeStorage({ throwOnWrite: true }));
    expect(writeSeat('ROOM1', WHITE)).toBe(false);
  });

  it('treats anything that is not a seat as no seat', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    const key = seatStorageKey('ROOM1');

    store.setItem(key, 'not json');
    expect(readSeat('ROOM1')).toBeNull();

    store.setItem(key, '42');
    expect(readSeat('ROOM1')).toBeNull();

    store.setItem(key, JSON.stringify({ token: '', colour: 'W', gameNumber: 1 }));
    expect(readSeat('ROOM1')).toBeNull();

    store.setItem(key, JSON.stringify({ token: 'a', colour: 'X', gameNumber: 1 }));
    expect(readSeat('ROOM1')).toBeNull();

    store.setItem(key, JSON.stringify({ token: 'a', colour: 'W' }));
    expect(readSeat('ROOM1')).toBeNull();

    store.setItem(key, JSON.stringify({ token: 'a', colour: 'W', gameNumber: null }));
    expect(readSeat('ROOM1')).toBeNull();
  });
});
