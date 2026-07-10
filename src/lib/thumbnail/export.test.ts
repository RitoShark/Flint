import { describe, it, expect } from 'vitest';
import { resolveOutputSize, scaleRect } from './export';

describe('resolveOutputSize', () => {
  it('16:9 -> 1920x1080', () => {
    expect(resolveOutputSize('16:9')).toEqual({ w: 1920, h: 1080 });
  });

  it('16:10 -> 1920x1200', () => {
    expect(resolveOutputSize('16:10')).toEqual({ w: 1920, h: 1200 });
  });

  it('4:3 -> 1440x1080', () => {
    expect(resolveOutputSize('4:3')).toEqual({ w: 1440, h: 1080 });
  });

  it('1:1 -> 1080x1080', () => {
    expect(resolveOutputSize('1:1')).toEqual({ w: 1080, h: 1080 });
  });

  it('unknown ratio defaults to 16:9', () => {
    expect(resolveOutputSize('bogus')).toEqual({ w: 1920, h: 1080 });
  });
});

describe('scaleRect', () => {
  it('scales a 640x360 authoring-space rect to a 1920x1080 output (2x)', () => {
    const rect = scaleRect({ x: 10, y: 20, w: 100, h: 50 }, 640, 360, 1920, 1080);
    expect(rect).toEqual({ x: 30, y: 60, w: 300, h: 150 });
  });

  it('scales non-uniformly when output aspect differs from authoring aspect (1:1 target)', () => {
    // 640x360 -> 1080x1080: scaleX = 1080/640 = 1.6875, scaleY = 1080/360 = 3
    const rect = scaleRect({ x: 0, y: 0, w: 640, h: 360 }, 640, 360, 1080, 1080);
    expect(rect.w).toBeCloseTo(1080, 5);
    expect(rect.h).toBeCloseTo(1080, 5);
  });

  it('identity when output size equals authoring size', () => {
    const rect = scaleRect({ x: 5, y: 5, w: 20, h: 20 }, 640, 360, 640, 360);
    expect(rect).toEqual({ x: 5, y: 5, w: 20, h: 20 });
  });
});
