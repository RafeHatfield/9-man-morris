import { describe, expect, it } from 'vitest';
import type { Action } from '@/lib/engine';
import { interpretTap } from './interaction';

const place = (point: number): Action => ({ type: 'place', point });
const move = (from: number, to: number): Action => ({ type: 'move', from, to });
const remove = (point: number): Action => ({ type: 'remove', point });

describe('interpretTap', () => {
  it('places on a legal empty point', () => {
    expect(interpretTap([place(4), place(5)], null, 5)).toEqual({
      kind: 'action',
      action: place(5),
    });
  });

  it('ignores a tap with no legal action and nothing selected', () => {
    expect(interpretTap([place(4)], null, 5)).toEqual({ kind: 'ignore' });
  });

  it('ignores every tap when the board is inert', () => {
    expect(interpretTap([], null, 0)).toEqual({ kind: 'ignore' });
  });

  it('selects a piece that has a legal move', () => {
    expect(interpretTap([move(3, 4)], null, 3)).toEqual({
      kind: 'select',
      point: 3,
    });
  });

  it('does not select a piece with no legal move', () => {
    expect(interpretTap([move(3, 4)], null, 9)).toEqual({ kind: 'ignore' });
  });

  it('moves to a legal destination of the selected piece', () => {
    expect(interpretTap([move(3, 4), move(3, 11)], 3, 11)).toEqual({
      kind: 'action',
      action: move(3, 11),
    });
  });

  it('deselects when the selected piece is tapped again', () => {
    expect(interpretTap([move(3, 4)], 3, 3)).toEqual({ kind: 'deselect' });
  });

  it('deselects when an unrelated point is tapped', () => {
    expect(interpretTap([move(3, 4)], 3, 20)).toEqual({ kind: 'deselect' });
  });

  it('swaps the selection to another movable piece', () => {
    expect(interpretTap([move(3, 4), move(9, 10)], 3, 9)).toEqual({
      kind: 'select',
      point: 9,
    });
  });

  it('removes a removable piece in removal mode', () => {
    expect(interpretTap([remove(2), remove(6)], null, 6)).toEqual({
      kind: 'action',
      action: remove(6),
    });
  });

  it('ignores a mill-protected piece in removal mode', () => {
    expect(interpretTap([remove(2)], null, 6)).toEqual({ kind: 'ignore' });
  });

  it('prefers a removal over a stale selection', () => {
    expect(interpretTap([remove(6)], 3, 6)).toEqual({
      kind: 'action',
      action: remove(6),
    });
  });
});
