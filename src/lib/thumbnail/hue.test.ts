import { describe, it, expect } from 'vitest';
import { resolveTextColor, resolveGlowColor } from './hue';

const HEX_RE = /^#[0-9a-f]{6}$/i;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function channelDeltas(a: string, b: string): number[] {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return [Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb)];
}

// Euclidean distance in RGB space — used to compare "closeness" without
// tying the assertion to the exact mix percentage implementation detail.
function dist(a: string, b: string): number {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
}

const BASE = '#f2ead9';

describe('resolveTextColor', () => {
  it('riot: stays close to base — each channel within a modest delta', () => {
    const out = resolveTextColor('riot', 210, BASE);
    expect(out).toMatch(HEX_RE);
    const deltas = channelDeltas(out, BASE);
    // ~12% mix — no channel should move more than ~40/255 for a hue whose
    // saturated RGB components can differ from base by up to ~255.
    for (const d of deltas) {
      expect(d).toBeLessThan(40);
    }
  });

  it('riot: varies only slightly across very different hues', () => {
    const a = resolveTextColor('riot', 0, BASE);
    const b = resolveTextColor('riot', 200, BASE);
    // Even opposite hues shouldn't push the subtle mix far apart.
    expect(dist(a, b)).toBeLessThan(60);
  });

  it('divine: moves a large fraction of the way toward the hue color', () => {
    const hue = 95;
    const hueColor = resolveGlowColor(hue);
    const out = resolveTextColor('divine', hue, BASE);
    expect(out).toMatch(HEX_RE);

    const distToBase = dist(out, BASE);
    const distToHue = dist(out, hueColor);
    // At ~80% mix, the result should be substantially nearer the hue color
    // than the base color.
    expect(distToHue).toBeLessThan(distToBase);
    // And it should have moved far from base (not a no-op).
    expect(distToBase).toBeGreaterThan(80);
  });

  it('divine output is clearly different across different hues (visibly reacts)', () => {
    const a = resolveTextColor('divine', 20, BASE);
    const b = resolveTextColor('divine', 260, BASE);
    expect(dist(a, b)).toBeGreaterThan(60);
  });

  it('riot moves noticeably less than divine for the same hue/base', () => {
    const hue = 30;
    const riotOut = resolveTextColor('riot', hue, BASE);
    const divineOut = resolveTextColor('divine', hue, BASE);
    expect(dist(riotOut, BASE)).toBeLessThan(dist(divineOut, BASE));
  });
});

describe('resolveGlowColor', () => {
  it('returns a valid hex color', () => {
    expect(resolveGlowColor(210)).toMatch(HEX_RE);
  });

  it('varies with hue', () => {
    const a = resolveGlowColor(0);
    const b = resolveGlowColor(180);
    expect(a).not.toBe(b);
  });

  it('wraps sensibly at hue 0 and 360 (same color)', () => {
    expect(resolveGlowColor(0)).toBe(resolveGlowColor(360));
  });
});
