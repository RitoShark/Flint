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
});
