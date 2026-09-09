/**
 * The sentences this API refuses in, and nothing else — no imports at all, so a
 * browser can hold this module without dragging the store, the engine or a
 * route handler into its bundle.
 *
 * That is the point of the file. A client has to tell "this server says the room
 * is gone" from "something between us returned a 404 with a JSON body", and the
 * only honest way to do that is to compare the message against the one the
 * server would have sent.
 *
 * Every refusal this API *authors*, worded once. Routes, tests and the client
 * refer to these by name — a sentence that exists twice is a sentence that can
 * drift.
 *
 * `schemas.ts` uses `timerNotOffered` as a Zod message, so it reaches the wire
 * prefixed with the field it is about: `timerMs: timerMs must be…`.
 *
 * Two kinds of message reach the wire from below and are not in here, because
 * they are not ours to word: `IllegalActionError` from the engine, which becomes
 * the 400 for an illegal move, and `VersionConflictError` from the store, which
 * becomes the 409 for a client that pinned a version — it names the version it
 * pinned and the one that is current, which is exactly what that client needs.
 */
export const REFUSAL = {
  roomNotFound: 'room not found',
  notAPlayer: 'this token does not hold a seat in this room',
  badBody: 'body is not valid JSON',
  waitingForOpponent: 'waiting for an opponent to join',
  gameOver: 'the game is over',
  gameNotOver: 'the game is not over',
  notYourTurn: 'it is not your turn',
  forfeitIsServerIssued: 'a forfeit is claimed through /claim-timeout',
  yourOwnClock: 'the clock is yours; only your opponent claims it',
  clockNotExpired: 'the clock has not expired',
  noTimer: 'this game has no turn timer',
  seatsTaken: 'both seats are taken',
  joinRaced: 'the room changed while joining; try again',
  roomBusy: 'the room changed while writing; try again',
  serverError: 'the server could not complete that request',
  timerNotOffered: 'timerMs must be one of the offered turn timers',
  differentGame: 'that was about a different game',
  differentOffer: 'that was about a different offer',
} as const;
