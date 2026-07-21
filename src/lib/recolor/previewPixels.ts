/**
 * Per-pixel recolor operations used by the Recolor modal's live preview.
 *
 * These are a frontend APPROXIMATION for guidance only — the authoritative
 * recolor happens in the Rust backend on save. The point is that what you see
 * tracks the controls (crucially, the "preserve original color intensity"
 * toggle actually changes the picture), which the old CSS-filter preview didn't.
 *
 * Every function mutates an RGBA `Uint8ClampedArray` in place, preserves alpha,
 * and skips fully-transparent pixels.
 */

/* --- colour-space helpers (0..255 rgb ⇄ h∈[0,360), s/l∈[0,1]) --- */

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [
        Math.round((r + m) * 255),
        Math.round((g + m) * 255),
        Math.round((b + m) * 255),
    ];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const v = max;
    const s = max === 0 ? 0 : d / max;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return [h, s, v];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    h = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [
        Math.round((r + m) * 255),
        Math.round((g + m) * 255),
        Math.round((b + m) * 255),
    ];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Hue Shift: rotate hue by `hueDeg`, multiply saturation by `sat` and value by
 * `bright`. Mirrors the CSS `hue-rotate/saturate/brightness` intent but in HSV
 * so it's a real per-pixel op.
 */
export function applyHueShift(
    data: Uint8ClampedArray,
    hueDeg: number,
    sat: number,
    bright: number,
): void {
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        const [r, g, b] = hsvToRgb(h + hueDeg, clamp01(s * sat), clamp01(v * bright));
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
}

/**
 * Colorize: replace every pixel's hue with `targetHueDeg`, keeping its original
 * lightness (so shading/detail survive). When `preserveIntensity` is true the
 * pixel keeps its own saturation; when false the saturation is pulled toward a
 * flatter, tinted look — this is what the checkbox visibly changes.
 */
export function applyColorize(
    data: Uint8ClampedArray,
    targetHueDeg: number,
    preserveIntensity: boolean,
): void {
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const [, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        const newS = preserveIntensity ? s : Math.min(s, 0.45) * 0.7;
        const [r, g, b] = hslToRgb(targetHueDeg, newS, l);
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
}

/**
 * Grayscale + Tint: collapse to luminance (Rec. 601) then lay a subtle tint of
 * `targetHueDeg` over it.
 */
export function applyGrayscaleTint(data: Uint8ClampedArray, targetHueDeg: number): void {
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        const [r, g, b] = hslToRgb(targetHueDeg, 0.28, lum);
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
}
