import { describe, expect, it } from 'vitest';
import * as engine from './index';
import { DRAW_MOVE_LIMIT } from './engine';

/**
 * The barrel is what every other item imports as `@/lib/engine`. This asserts the
 * GDD §7.1 surface actually comes out of it.
 */
describe('the public entry point', () => {
  it('re-exports the GDD §7.1 functions', () => {
    for (const name of [
      'initialState',
      'legalActions',
      'apply',
      'formsMill',
      'removablePieces',
      // Beyond §7.1, but imported through this barrel by the board UI and the API.
      'millsThrough',
      'agreeDraw',
      'opponentOf',
    ] as const) {
      expect(typeof engine[name]).toBe('function');
    }
  });

  it('re-exports the board tables the app draws and validates against', () => {
    expect(engine.ADJACENCY).toHaveLength(24);
    expect(engine.MILLS).toHaveLength(16);
    expect(engine.POINT_COUNT).toBe(24);
    expect(engine.IllegalActionError.prototype).toBeInstanceOf(Error);
  });

  it('is a list of what the app imports, not of everything exported', () => {
    // `POINTS`, `LINES_THROUGH` and `DRAW_MOVE_LIMIT` are reachable from './board'
    // and './engine', which is how the engine's own tests use them; they are off
    // the public surface because nothing outside src/lib/engine imports them.
    // `PIECES_PER_PLAYER` and `isOver` are not exported from anywhere at all.
    const surface = Object.keys(engine);
    for (const internal of [
      'POINTS',
      'LINES_THROUGH',
      'PIECES_PER_PLAYER',
      'DRAW_MOVE_LIMIT',
      'isOver',
    ]) {
      expect(surface).not.toContain(internal);
    }
  });

  it('starts a game through the barrel', () => {
    const s = engine.initialState();
    expect(engine.legalActions(s)).toHaveLength(24);
    expect(engine.apply(s, { type: 'place', point: 0 }, 'W').board[0]).toBe('W');
  });
});

describe('IllegalActionError', () => {
  it('is a named Error, so a catch site can tell it apart', () => {
    const e = new engine.IllegalActionError('nope');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('IllegalActionError');
    expect(e.message).toBe('nope');
  });
});

describe('the closed alphabets', () => {
  it('exports each as a runtime list the types are derived from', () => {
    expect(engine.PLAYERS).toEqual(['W', 'B']);
    expect(engine.PHASES).toEqual(['placing', 'moving', 'over']);
    expect(engine.REASONS).toEqual([
      'millout',
      'blocked',
      'forfeit',
      'resign',
      'draw50',
      'drawagreed',
    ]);
  });

  it('covers every value the engine can actually produce', () => {
    const fresh = engine.initialState();
    expect(engine.PLAYERS).toContain(fresh.turn);
    expect(engine.PHASES).toContain(fresh.phase);

    const board = (spec: string): engine.Cell[] =>
      [...spec.replace(/\s/g, '')].map((c) =>
        c === 'W' ? 'W' : c === 'B' ? 'B' : null,
      );
    const moving = (spec: string, patch: Partial<engine.GameState> = {}) => ({
      ...fresh,
      board: board(spec),
      hand: { W: 0, B: 0 },
      phase: 'moving' as const,
      ...patch,
    });

    // Each of the six, produced by the rule that produces it — not listed.
    const reached = [
      engine.apply(fresh, { type: 'resign' }, 'W').result,
      engine.apply(fresh, { type: 'forfeit', player: 'W' }, 'B').result,
      engine.agreeDraw(fresh).result,
      // millout: the removal that takes Black's third piece.
      engine.apply(
        moving('WWW..W.. BB.B.... ........', { pendingRemoval: true }),
        { type: 'remove', point: 11 },
        'W',
      ).result,
      // blocked: White seals Black's last exit.
      engine.apply(
        moving('BBBW...W ..W..... ........', { turn: 'W' }),
        { type: 'move', from: 10, to: 9 },
        'W',
      ).result,
      // draw50: the fiftieth movement-phase move with nothing taken.
      engine.apply(
        moving('W.WW.... .B.BB... ........', {
          movesSinceRemoval: DRAW_MOVE_LIMIT - 1,
        }),
        { type: 'move', from: 0, to: 1 },
        'W',
      ).result,
    ];
    const reasons = new Set(reached.map((r) => r!.reason));
    expect([...reasons].sort()).toEqual([...engine.REASONS].sort());
  });

  it('freezes them, like the board tables', () => {
    for (const list of [engine.PLAYERS, engine.PHASES, engine.REASONS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});

describe('the type-only surface', () => {
  it('keeps Result off the barrel', () => {
    // `Object.keys` cannot see a type-only export, so the absence pin above is
    // blind to `Result`. This import is the pin: it is an error today, and the
    // `@ts-expect-error` turns it into a *failure* the moment it stops being one.
    // @ts-expect-error `Result` is deliberately not re-exported from the barrel.
    type FromBarrel = import('./index').Result;
    const unused: FromBarrel | undefined = undefined;
    expect(unused).toBeUndefined();
  });
});
