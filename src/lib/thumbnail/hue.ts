/**
 * Global mod-hue theme (Task 12).
 *
 * ONE hue slider (0–360) drives:
 *  - text color: a small nudge toward the hue for the Riot style (the text
 *    should mostly stay its cream/gold base — "just to keep theming with
 *    the total thing but shouldn't be that much visible"), and a strong
 *    pull toward the hue for the Divine style ("make sure text change is
 *    significant cuz that style has more glow and colors").
 *  - glow: a saturated color at the hue, taken directly (not mixed) — see
 *    `resolveGlowColor`. Wiring this into the scene's actual glow render
 *    is limited by the current `setGlow(id, on, intensity)` contract (no
 *    color channel) — see ThumbnailArtboard's wiring comment.
 *
 * Pure module: no DOM, no scene access. Safe to unit test directly.
 */

export type ThumbnailPresetId = 'riot' | 'divine';

// How much of the hue color to mix into the base text color, per style.
// Riot: subtle theming, base stays dominant. Divine: the text visibly
// takes the accent color.
const RIOT_TEXT_MIX = 0.12;
const DIVINE_TEXT_MIX = 0.8;

// Saturation/lightness used when turning a bare hue (0-360) into an actual
// RGB color for mixing/glow. Chosen to be a vivid-but-not-neon accent that
// still reads well mixed into a cream base or used standalone as a glow.
const HUE_SAT = 0.7;
const HUE_LIGHT = 0.55;

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHex2(n: number): string {
  return clampByte(n).toString(16).padStart(2, '0');
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** hue (0-360, wraps) -> [r,g,b] at a fixed sat/light tuned for this theme. */
function hueToRgb(hue: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const s = HUE_SAT;
  const l = HUE_LIGHT;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp >= 0 && hp < 1) { r1 = c; g1 = x; b1 = 0; }
  else if (hp < 2) { r1 = x; g1 = c; b1 = 0; }
  else if (hp < 3) { r1 = 0; g1 = c; b1 = x; }
  else if (hp < 4) { r1 = 0; g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }
  const m = l - c / 2;

  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

function mixHex(baseHex: string, hueHex: string, amount: number): string {
  const [br, bg, bb] = hexToRgb(baseHex);
  const [hr, hg, hb] = hexToRgb(hueHex);
  const r = br + (hr - br) * amount;
  const g = bg + (hg - bg) * amount;
  const b = bb + (hb - bb) * amount;
  return rgbToHex(r, g, b);
}

/**
 * Saturated hue color, taken directly (no mixing) — used for glow tint and
 * as the mix target for `resolveTextColor`.
 */
export function resolveGlowColor(hue: number): string {
  const [r, g, b] = hueToRgb(hue);
  return rgbToHex(r, g, b);
}

/**
 * Text color for a given style + hue, mixed from `baseHex` (the style's
 * hardcoded cream/gold) toward the hue color. Riot mixes subtly (~12%);
 * Divine mixes strongly (~80%).
 */
export function resolveTextColor(preset: ThumbnailPresetId, hue: number, baseHex: string): string {
  const amount = preset === 'divine' ? DIVINE_TEXT_MIX : RIOT_TEXT_MIX;
  const hueHex = resolveGlowColor(hue);
  return mixHex(baseHex, hueHex, amount);
}

/**
 * Per-layer text treatment (hue mix + colored glow), resolved from the theme
 * hue. `hueMix` overrides the preset-wide mix when provided (0 = stay at the
 * base color, 1 = fully the hue color). When `glow` is on, the glow color is
 * the SAME as the text color (so the hue slider drives both), rendered as
 * layered shadows whose blur scales with `glowStrength` (0..1).
 *
 * Returns the resolved `color` plus a ready-to-use CSS `textShadow` string
 * (base drop-shadow for legibility, plus glow passes when enabled). The export
 * compositor consumes `color` + `glowColor`/`glowBlur` directly (canvas has no
 * CSS text-shadow) — see `resolveTextGlow`.
 */
export interface TextStyleOpts {
  hueMix?: number;
  glow?: boolean;
  glowStrength?: number;
}

/** Resolved text color for the given preset default + per-layer override. */
export function resolveTextColorEx(preset: ThumbnailPresetId, hue: number, baseHex: string, hueMix?: number): string {
  const amount = hueMix ?? (preset === 'divine' ? DIVINE_TEXT_MIX : RIOT_TEXT_MIX);
  const hueHex = resolveGlowColor(hue);
  return mixHex(baseHex, hueHex, Math.max(0, Math.min(1, amount)));
}

/** Glow geometry for a text layer: the glow `color` (= the text color) and the
 *  `blur` radius (px in 640×360 authoring space; scale on export). Returns null
 *  when glow is off / has no visible extent. Pure — shared by preview + export. */
export function resolveTextGlow(color: string, opts: TextStyleOpts): { color: string; blur: number } | null {
  if (!opts.glow) return null;
  const strength = Math.max(0, Math.min(1, opts.glowStrength ?? 0.6));
  // Blur scales linearly FROM 0 so strength 0 = no visible glow at all.
  const blur = strength * 26;
  if (blur <= 0) return null;
  return { color, blur };
}

/** Full CSS treatment for a text layer (preview). Base cream-vs-hue color plus
 *  a legibility drop-shadow, plus colored glow passes when enabled. */
export function resolveTextStyle(preset: ThumbnailPresetId, hue: number, baseHex: string, opts: TextStyleOpts): { color: string; textShadow: string } {
  const color = resolveTextColorEx(preset, hue, baseHex, opts.hueMix);
  const shadows = ['0 2px 12px rgba(0,0,0,.55)'];
  const glow = resolveTextGlow(color, opts);
  if (glow) {
    // A tight bright core + a wider soft halo, both centered — a real emissive
    // glow BEHIND the legibility shadow (which is behind the crisp text fill),
    // so the glow never sits on top of the letters.
    shadows.unshift(`0 0 ${glow.blur}px ${glow.color}`);
    shadows.unshift(`0 0 ${(glow.blur * 2).toFixed(2)}px ${glow.color}`);
  }
  return { color, textShadow: shadows.join(', ') };
}

/** A deep, hue-tinted background: an off-center radial glow over a dark
 *  diagonal gradient — the same shape as the old hardcoded `.tb-env`, but
 *  driven by the theme hue so the whole backdrop recolors with the slider.
 *  Returns a CSS `background` shorthand value. */
export function resolveBackground(hue: number): string {
  const h = ((hue % 360) + 360) % 360;
  // Glow = a soft, mid-sat tint of the hue; base = two very dark hue-tinted
  // stops so it never washes out but still reads as themed.
  const glow = `hsla(${h}, 60%, 45%, 0.32)`;
  const darkA = `hsl(${h}, 45%, 12%)`;
  const darkMid = `hsl(${h}, 55%, 20%)`;
  const darkB = `hsl(${h}, 50%, 7%)`;
  return `radial-gradient(circle at 64% 42%, ${glow}, transparent 52%), linear-gradient(120deg, ${darkA} 0%, ${darkMid} 42%, ${darkB} 100%)`;
}
