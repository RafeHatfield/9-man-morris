/**
 * Room ids and player tokens (GDD §7.2).
 *
 * Room ids are 8 characters from an unambiguous alphabet — no `0`/`O`, no
 * `1`/`I`/`l` — because they are read off a screen and typed by hand as often as
 * they are tapped. Crockford's base32 minus `0` and `1`, i.e. 30 symbols, giving
 * 30^8 ≈ 6.6e11 ids: collision-free enough for rooms that live 7 days.
 */

/** Uppercase only: mixed case would make a shared link case-sensitive. */
export const ROOM_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ROOM_ID_LENGTH = 8;

/**
 * Largest multiple of the alphabet size that fits in a byte. Bytes at or above
 * it are discarded rather than folded in, so every symbol is equally likely.
 */
const UNBIASED_LIMIT =
  256 - (256 % ROOM_ID_ALPHABET.length); // 240 for a 30-symbol alphabet

/** A crypto-random room id. Uses Web Crypto, so it runs on Node and on Edge. */
export function newRoomId(): string {
  let id = '';
  while (id.length < ROOM_ID_LENGTH) {
    const bytes = crypto.getRandomValues(
      new Uint8Array(ROOM_ID_LENGTH - id.length),
    );
    for (const byte of bytes) {
      if (byte >= UNBIASED_LIMIT) continue;
      id += ROOM_ID_ALPHABET[byte % ROOM_ID_ALPHABET.length];
    }
  }
  return id;
}

/**
 * Bytes of entropy in a player token. A token is a bearer credential — whoever
 * holds it owns the seat (GDD §5.1) — so it is much longer than a room id and
 * drawn from the full byte range rather than a human-readable alphabet: nobody
 * ever types one, it lives in `localStorage`.
 */
export const PLAYER_TOKEN_BYTES = 16;

/** A crypto-random player token, 32 lowercase hex characters. */
export function newPlayerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PLAYER_TOKEN_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
