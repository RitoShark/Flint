import { describe, it, expect } from 'vitest';
import { createHistory } from './history';
const L = (x: number): any => [{ id: 'a', type: 'text', name: 'T', hidden: false, rot: 0, locked: false, x, y: 0, w: 1, h: 1, text: '', size: 1, font: '', italic: false, spacing: 0 }];

describe('history', () => {
  it('undo restores previous recorded state', () => {
    const h = createHistory(L(0));
    h.set(L(5), true);
    expect(h.get()[0].x).toBe(5);
    h.undo();
    expect(h.get()[0].x).toBe(0);
  });
  it('redo re-applies', () => { const h = createHistory(L(0)); h.set(L(5), true); h.undo(); h.redo(); expect(h.get()[0].x).toBe(5); });
  it('canUndo/canRedo flags', () => { const h = createHistory(L(0)); expect(h.canUndo()).toBe(false); h.set(L(1), true); expect(h.canUndo()).toBe(true); });
  it('begin/commitGesture makes a drag-style edit undoable even after no-record frames', () => {
    const h = createHistory(L(0));
    h.begin();
    h.set(L(3), false);   // drag frame
    h.set(L(7), false);   // drag frame (final)
    h.commitGesture();    // release
    expect(h.get()[0].x).toBe(7);
    expect(h.canUndo()).toBe(true);
    h.undo();
    expect(h.get()[0].x).toBe(0);   // back to the pre-gesture baseline
  });
  it('commitGesture with no net change records nothing', () => {
    const h = createHistory(L(0));
    h.begin();
    h.set(L(0), false);
    h.commitGesture();
    expect(h.canUndo()).toBe(false);
  });
});
