import { describe, it, expect } from 'vitest';
import { fitFontSize } from './textFit';

// Fake measure: width scales with char count * size, height == size.
const measure = (t: string, s: number) => ({ w: t.length * s * 0.6, h: s });

describe('fitFontSize', () => {
  it('shrinks below maxSize when a single line is too wide for the box', () => {
    // "WIDE" (4 chars) in a 100px box: 4*0.6*s <= 100 -> s <= ~41.6
    expect(fitFontSize(measure, ['WIDE'], 100, 200, 60)).toBeLessThanOrEqual(42);
  });

  it('returns maxSize unchanged when the text already fits at max', () => {
    expect(fitFontSize(measure, ['A'], 1000, 1000, 40)).toBe(40);
  });

  it('the returned size actually fits the box (width and height)', () => {
    const lines = ['WIDE'];
    const boxW = 100, boxH = 200, maxSize = 60;
    const size = fitFontSize(measure, lines, boxW, boxH, maxSize);
    for (const line of lines) {
      expect(measure(line, size).w).toBeLessThanOrEqual(boxW);
    }
    const totalH = lines.reduce((sum, line) => sum + measure(line, size).h, 0);
    expect(totalH).toBeLessThanOrEqual(boxH);
  });

  it('multi-line: shrinks so total height of all lines fits boxH', () => {
    // 2 lines, each h == size. maxSize 60 -> total 120, boxH 100 -> must shrink to <=50.
    const size = fitFontSize(measure, ['A', 'B'], 1000, 100, 60);
    expect(size).toBeLessThanOrEqual(50);
    const totalH = ['A', 'B'].reduce((sum, line) => sum + measure(line, size).h, 0);
    expect(totalH).toBeLessThanOrEqual(100);
  });

  it('multi-line: the widest line constrains the size, not just the first', () => {
    // second line is much wider than the first
    const size = fitFontSize(measure, ['A', 'WIDE LINE HERE'], 200, 1000, 60);
    for (const line of ['A', 'WIDE LINE HERE']) {
      expect(measure(line, size).w).toBeLessThanOrEqual(200);
    }
  });

  it('never returns below minSize even if nothing fits', () => {
    const size = fitFontSize(measure, ['THIS IS A VERY LONG LINE OF TEXT'], 10, 10, 60);
    expect(size).toBeGreaterThanOrEqual(6); // default minSize
  });

  it('respects a custom minSize floor', () => {
    const size = fitFontSize(measure, ['THIS IS A VERY LONG LINE OF TEXT'], 10, 10, 60, 12);
    expect(size).toBeGreaterThanOrEqual(12);
  });

  it('empty lines array returns maxSize', () => {
    expect(fitFontSize(measure, [], 100, 100, 40)).toBe(40);
  });
});
