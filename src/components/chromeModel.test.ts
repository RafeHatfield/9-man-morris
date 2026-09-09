/**
 * The chrome's wording and counts (GDD §6.1, §6.3), as pure functions over real
 * engine states. `StatusBar.tsx` and `BottomBar.tsx` are layout over exactly these.
 */

import { describe, expect, it } from 'vitest';
import {
  agreeDraw,
  apply,
  initialState,
  type Action,
  type GameState,
  type Reason,
} from '@/lib/engine';
import { pieceCounts, statusDetail, statusHeadline } from './chromeModel';

function play(script: readonly Action[]): GameState {
  return script.reduce((s, a) => apply(s, a, s.turn), initialState());
}

const place = (point: number): Action => ({ type: 'place', point });

/** A finished state with the given result, for wording tests. */
function over(winner: 'W' | 'B' | null, reason: Reason): GameState {
  return { ...initialState(), phase: 'over', result: { winner, reason } };
}

describe('statusHeadline', () => {
  it('names the player to move in hot-seat, where there is no "you"', () => {
    const s = initialState();
    expect(statusHeadline(s)).toBe('White to play');
    expect(statusHeadline(s, null)).toBe('White to play');
    expect(statusHeadline(play([place(0)]))).toBe('Black to play');
  });

  it('says whose turn it is from the viewer’s seat (§6.2)', () => {
    const s = initialState();
    expect(statusHeadline(s, 'W')).toBe('Your turn');
    expect(statusHeadline(s, 'B')).toBe('Waiting for White…');
    expect(statusHeadline(play([place(0)]), 'W')).toBe('Waiting for Black…');
    expect(statusHeadline(play([place(0)]), 'B')).toBe('Your turn');
  });

  it('reports the result and its reason (§6.3), whoever is asking', () => {
    expect(statusHeadline(over('W', 'millout'))).toBe('White wins — mill-out');
    expect(statusHeadline(over('B', 'blocked'), 'W')).toBe('Black wins — blocked');
    expect(statusHeadline(over('W', 'forfeit'), 'W')).toBe('White wins — forfeit');
    expect(statusHeadline(over('B', 'resign'))).toBe('Black wins — resignation');
    expect(statusHeadline(over(null, 'draw50'))).toBe('Draw — 50-move rule');
    expect(statusHeadline(over(null, 'drawagreed'))).toBe('Draw — agreed');
  });

  it('prefers the result over the turn once the game is over', () => {
    const drawn = agreeDraw(initialState());
    expect(statusHeadline(drawn, 'W')).toBe('Draw — agreed');
  });
});

describe('statusDetail', () => {
  it('names the phase', () => {
    expect(statusDetail(initialState())).toBe('Placement');
    const moving = play(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18].map(place),
    );
    expect(moving.phase).toBe('moving');
    expect(statusDetail(moving)).toBe('Movement');
    expect(statusDetail(over('W', 'millout'))).toBe('Game over');
  });

  it('prompts for the removal while one is pending (§6.1)', () => {
    const milled = play([place(0), place(8), place(1), place(9), place(2)]);
    expect(milled.pendingRemoval).toBe(true);
    expect(statusDetail(milled)).toBe('Mill! White removes a Black piece.');
  });

  it('names the other side correctly when Black is the one removing', () => {
    const milled = play([
      place(0), place(8), place(4), place(9), place(12), place(10),
    ]);
    expect(statusDetail(milled)).toBe('Mill! Black removes a White piece.');
  });

  it('does not prompt for a removal once the game is over', () => {
    const stuck: GameState = {
      ...initialState(),
      pendingRemoval: true,
      phase: 'over',
      result: { winner: 'W', reason: 'resign' },
    };
    expect(statusDetail(stuck)).toBe('Game over');
  });

  it('labels a read-only visitor (§6.4)', () => {
    expect(statusDetail(initialState(), true)).toBe('Placement · Spectating');
    expect(statusDetail(initialState(), false)).toBe('Placement');
  });
});

describe('pieceCounts', () => {
  it('starts with nine in hand and none on the board', () => {
    expect(pieceCounts(initialState(), 'W')).toEqual({ hand: 9, onBoard: 0 });
    expect(pieceCounts(initialState(), 'B')).toEqual({ hand: 9, onBoard: 0 });
  });

  it('moves a piece from hand to board on a placement', () => {
    const s = play([place(0), place(8)]);
    expect(pieceCounts(s, 'W')).toEqual({ hand: 8, onBoard: 1 });
    expect(pieceCounts(s, 'B')).toEqual({ hand: 8, onBoard: 1 });
  });

  it('drops the board count on a removal without returning it to hand', () => {
    const milled = play([place(0), place(8), place(1), place(9), place(2)]);
    const taken = apply(milled, { type: 'remove', point: 8 }, milled.turn);
    expect(pieceCounts(taken, 'W')).toEqual({ hand: 6, onBoard: 3 });
    expect(pieceCounts(taken, 'B')).toEqual({ hand: 7, onBoard: 1 });
  });
});

describe('statusHeadline while a room waits for its second player', () => {
  it('says why the board is inert, whichever seat is asking', () => {
    const s = initialState();
    expect(statusHeadline(s, 'W', true)).toBe('Waiting for an opponent…');
    expect(statusHeadline(s, null, true)).toBe('Waiting for an opponent…');
    // Never "Your turn" over a board that refuses every tap (GDD §6.2).
    expect(statusHeadline(s, 'W', false)).toBe('Your turn');
  });

  it('still leads with the result once the game is over', () => {
    const over = {
      ...initialState(),
      phase: 'over' as const,
      result: { winner: 'B' as const, reason: 'resign' as const },
    };
    expect(statusHeadline(over, 'W', true)).toBe('Black wins — resignation');
  });
});
