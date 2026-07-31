/* Color conversion for the paint panel. BIN colors are linear-ish f32 vec4s in
   0..1; the pickers and swatches work in 8-bit hex. Kept separate from the
   components so the rounding rules are testable and stated in one place. */

export type Vec4 = [number, number, number, number];

function clamp01(v: number): number {
    return Math.min(1, Math.max(0, v));
}

function toByte(v: number): number {
    return Math.round(clamp01(v) * 255);
}

/** `#rrggbb` for the RGB of a vec4. Alpha is carried separately — the pickers
 *  edit it on its own control, and a 8-digit hex would silently drop it in the
 *  `<input type="color">` round-trip. */
export function vec4ToHex(v: Vec4): string {
    const hex = (n: number) => toByte(n).toString(16).padStart(2, '0');
    return `#${hex(v[0])}${hex(v[1])}${hex(v[2])}`;
}

/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` into a vec4. Returns null on anything
 *  else so callers can keep the previous value rather than writing black. */
export function hexToVec4(hex: string, fallbackAlpha = 1): Vec4 | null {
    let s = hex.trim().replace(/^#/, '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (s.length !== 6 && s.length !== 8) return null;
    if (!/^[0-9a-fA-F]+$/.test(s)) return null;

    const byte = (i: number) => parseInt(s.slice(i * 2, i * 2 + 2), 16) / 255;
    return [
        byte(0),
        byte(1),
        byte(2),
        s.length === 8 ? byte(3) : clamp01(fallbackAlpha),
    ];
}

/** CSS color for a swatch, alpha included so a translucent keyframe reads as
 *  translucent against the checkerboard behind it. */
export function vec4ToCss(v: Vec4): string {
    return `rgba(${toByte(v[0])}, ${toByte(v[1])}, ${toByte(v[2])}, ${clamp01(v[3]).toFixed(3)})`;
}
