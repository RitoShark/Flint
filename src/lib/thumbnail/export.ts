/**
 * Composite export (Task 13) — renders the final poster by drawing the
 * Babylon scene screenshot + disc/deco images + hue-resolved auto-shrunk
 * text onto a 2D canvas at the chosen output resolution, then encodes it
 * as WebP (default) / PNG / JPEG.
 *
 * ── Composite draw order (documented; MUST match the live preview) ──
 *
 * The artboard (`ThumbnailArtboard.tsx`) paints, in DOM order (= visual
 * stacking, since every stage child is `position:absolute` with no
 * competing z-index):
 *   1. `.tb-env`               — a static CSS gradient "environment slot"
 *   2. `<canvas class="tb-scene-canvas">` — the shared Babylon scene (every
 *      `model` layer's real SKN render)
 *   3. `sorted` layers (by `zrank`): disc-back(20) < model(40) <
 *      deco-behind(12, actually lower than disc) < deco-front(65) < text(80)
 *   4. the disc's separate FRONT overlay (the gold ring only)
 *
 * Critically, `createThumbnailScene` (`studioScene.ts`) builds its Babylon
 * `Engine` with `alpha: true`, but nothing in this codebase ever calls
 * `scene.setEnvImage(path, fit)` (grepped — zero call sites), so
 * `scene.clearColor` stays at its `no-env` default,
 * `new Color4(0.106, 0.106, 0.106, 1.0)` — **alpha = 1, fully OPAQUE**.
 * `Tools.CreateScreenshotUsingRenderTarget` renders the SAME scene/clearColor,
 * so the screenshot Blob is likewise a fully opaque image. That opaque
 * canvas fills the whole stage and paints AFTER `.tb-env` but BEFORE the
 * `.tb-el` layers in DOM order, so today it already fully occludes
 * `.tb-env` wherever the canvas has pixels (everywhere). The disc's back
 * pieces (glow + black fill) are NOT occluded, though — they're painted by
 * the disc's `.tb-el` (`LayerBody`'s `part="back"` `DiscComposite`), a DOM
 * node that sits ABOVE the scene canvas in DOM order (zrank 20, same as
 * every other `.tb-el`), so they composite on top of the screenshot and ARE
 * visible in the live preview. (A future task wiring a real `env` layer
 * image through `setEnvImage` would flip the scene to a transparent clear
 * color and additionally reveal `.tb-env` itself — out of scope here; see
 * the `env` layer type that already exists in `layers.ts` but has no UI
 * yet.)
 *
 * So the draw order that reproduces the CURRENT preview pixel-for-pixel is:
 *   1. Scene screenshot (opaque — already includes the dark background AND
 *      the model; this alone already covers where `.tb-env` would have
 *      shown through, matching today's preview exactly — `.tb-env` itself
 *      stays hidden until a real `env` image is wired up)
 *   2. Disc back pieces (glow + black fill) — drawn on top of the
 *      screenshot, same as the preview's disc `.tb-el` painting above the
 *      scene canvas, so they ARE visible here just like in the preview.
 *   3. Deco layers with `z: 'behind'` (zrank 12, below the disc even)
 *   4. Disc RING (front band) — zrank of the disc's overlay puts it above
 *      every model/deco-behind, matching `tb-disc-front-overlay` being
 *      painted after every `.tb-el`.
 *   5. Deco layers with `z: 'front'` (zrank 65)
 *   6. Text layers (zrank 80, always last)
 *
 * DECO ASSETS (`deco.asset`): per CLAUDE.md's Task 13 coverage notes,
 * corner/logo image slots are a DEFERRED feature — `LayerBody` in
 * `ThumbnailArtboard.tsx` never actually renders `deco.asset` as an image
 * today (only a placeholder "corner PNG slot" box), and the field holds a
 * raw filesystem path typed by the user (`PropertiesPanel`'s `DecoProps`),
 * not a `convertFileSrc`/blob URL `fetch` could load directly. So this
 * compositor likewise does NOT attempt to draw `deco.asset` images (that
 * would silently diverge from the still-placeholder preview, or throw on a
 * bare Windows path) — deco layers are structurally supported (z-order
 * slots exist below) but a no-op visually until that feature is built.
 *
 * NOTE: on a 2D canvas, "paint order" and "code order" are the same thing
 * (later draws composite ON TOP), so step 2 (disc back pieces) is issued
 * AFTER step 1 (the screenshot) in `composeThumbnail`'s code, even though
 * conceptually the back pieces belong "behind" the model. This mirrors the
 * preview, where the disc `.tb-el` is likewise a DOM sibling painted after
 * (on top of) the scene canvas — so the pieces show through only where the
 * model doesn't cover them, in both preview and export. See the `.tb-env`
 * paragraph above for the one piece (`.tb-env` itself) that stays hidden
 * either way until a real `env` image is wired up. Documented so nobody
 * "fixes" the ordering later without re-reading this comment.
 */

import type { Layer, TextLayer, DiscLayer, DecoLayer, FrameLayer } from './layers';
import type { ThumbnailScene } from './studioScene';
import type { MapEnvScene } from './mapEnvScene';
import { fitFontSize, type TextMeasure } from './textFit';
import { resolveGlowColor, resolveTextColorEx, resolveTextGlow, type ThumbnailPresetId } from './hue';
import { loadThumbnailAsset, type ThumbnailAssetName } from '../api/thumbnail';

export type ExportFormat = 'image/webp' | 'image/png' | 'image/jpeg';

export interface OutputSize {
  w: number;
  h: number;
}

const RATIO_SIZES: Record<string, OutputSize> = {
  '16:9': { w: 1920, h: 1080 },
  '16:10': { w: 1920, h: 1200 },
  '4:3': { w: 1440, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
};

const DEFAULT_RATIO = '16:9';

/** Maps a ratio id (as used by the ratio picker) to its exact output pixel
 *  size. Unknown ratios default to 16:9. Pure — TDD'd directly. */
export function resolveOutputSize(ratio: string): OutputSize {
  return RATIO_SIZES[ratio] ?? RATIO_SIZES[DEFAULT_RATIO];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Scales a rect from the fixed 640x360 authoring space (`STAGE_W`/`STAGE_H`
 *  in `ThumbnailArtboard.tsx`) to an arbitrary output pixel size. Scales X
 *  and Y independently (non-uniform) so the composite always fills the
 *  chosen output ratio exactly the same way the live artboard's `tb-stage`
 *  would if it were resized to that ratio — matches how `.tb-el` layers are
 *  authored as raw pixel boxes against the fixed 640x360 stage. Pure. */
export function scaleRect(rect: Rect, authoringW: number, authoringH: number, outW: number, outH: number): Rect {
  const sx = outW / authoringW;
  const sy = outH / authoringH;
  return {
    x: rect.x * sx,
    y: rect.y * sy,
    w: rect.w * sx,
    h: rect.h * sy,
  };
}

// Disc composite fixed offsets, mirrored from DiscComposite.tsx (see that
// file's comment for the provenance of these pixel offsets against the
// saved Riot preset). Duplicated here (not imported) because
// DiscComposite.tsx is a React component module (imports react-dom-ish
// hooks) that we don't want to pull into this non-DOM compositor — these
// are pure composite-geometry constants, not UI.
const GLOW_OFFSET = { dx: 16, dy: 0, w: 168, h: 360 };
const BLACK_OFFSET = { dx: 16, dy: -26, w: 407, h: 412 };
const RING_OFFSET = { dx: 0, dy: 0, w: 123, h: 360 };

// Same base cream/gold text color the artboard hardcodes in
// `ThumbnailArtboard.tsx` (`TEXT_BASE_COLOR`) — kept as a literal copy
// (not imported) since that constant isn't exported; if the artboard's
// value ever changes, update this one too so exported posters keep
// matching the editor preview.
const TEXT_BASE_COLOR = '#f2ead9';

const TEXT_LINE_HEIGHT = 1.1;

// Fixed authoring canvas size (mirrors STAGE_W/STAGE_H in ThumbnailArtboard.tsx).
const STAGE_W = 640;
const STAGE_H = 360;

export interface ComposeOptions {
  /** Live scene instance (Task 8/9) — its current screenshot is drawn as
   *  the base layer (model + baked-in background). */
  scene: ThumbnailScene;
  /** The 3D map-env scene (own engine), if a map layer is present. Its
   *  screenshot is drawn BEHIND the disc (z-order map → disc → models). */
  mapScene?: MapEnvScene | null;
  /** Full layer stack, in the SAME order as `history.get()` — z-order is
   *  derived internally the same way the artboard derives it (via zrank),
   *  hidden layers are skipped. */
  layers: Layer[];
  preset: ThumbnailPresetId;
  hue: number;
  /** Vignette strength (0-100). Drawn over the composition, below text. */
  vignette?: number;
  /** Bottom-right corner glow strength (0-100). Generated hue-tinted bloom. */
  cornerGlow?: number;
  outW: number;
  outH: number;
  format: ExportFormat;
  /** Quality for lossy formats (webp/jpeg), 0-1. Defaults to 0.92. */
  quality?: number;
}

// Cached bundled-asset object URLs, keyed by asset name (ring/glow/stroke).
const assetUrlCache = new Map<string, Promise<string>>();

/** Loads a bundled thumbnail WebP asset as an object URL, cached at module
 *  scope (mirrors `DiscComposite.tsx`/`FrameComposite.tsx` caches — this module
 *  can't reuse those since they're private to the component files, but the
 *  underlying `loadThumbnailAsset` fetch is the same call). */
function bundledAssetUrl(name: ThumbnailAssetName): Promise<string> {
  const cached = assetUrlCache.get(name);
  if (cached) return cached;
  const p = loadThumbnailAsset(name).then(bytes => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/webp' })));
  assetUrlCache.set(name, p);
  return p;
}

/** Convert a `#rrggbb` hex to `rgba(r,g,b,a)`. */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

/** Applies a layer's drop-shadow style to the canvas ctx (in output px), or
 *  clears it when the layer casts no shadow. Offsets/blur are authored in the
 *  640×360 stage space, so scale by `scale` (= outW / STAGE_W). Mirrors the
 *  preview's `shadowFilter` CSS drop-shadow. */
function applyLayerShadow(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  layer: Layer,
  scale: number,
): void {
  if (!layer.shadow) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    return;
  }
  ctx.shadowColor = `rgba(0,0,0,${layer.shadowOpacity ?? 0.5})`;
  ctx.shadowBlur = (layer.shadowBlur ?? 8) * scale;
  ctx.shadowOffsetX = (layer.shadowOffsetX ?? 0) * scale;
  ctx.shadowOffsetY = (layer.shadowOffsetY ?? 6) * scale;
}

async function loadImageBitmapFromUrl(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function canvasMeasureFor(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, layer: TextLayer, scale: number): TextMeasure {
  return (text: string, size: number) => {
    ctx.font = `${layer.italic ? 'italic ' : ''}800 ${size}px ${layer.font}`;
    // letterSpacing is set here (not just in drawTextLayer) so measureText
    // already includes the tracking between glyphs — matching what actually
    // gets painted. Do NOT also add `(text.length-1)*spacing` on top of this;
    // that would double-count now that the native letterSpacing is active.
    ctx.letterSpacing = `${layer.spacing * scale}px`;
    const w = ctx.measureText(text).width;
    return { w, h: size * TEXT_LINE_HEIGHT };
  };
}

function drawDiscPiece(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  disc: DiscLayer,
  offset: { dx: number; dy: number; w: number; h: number },
  outW: number,
  outH: number,
  bitmap: ImageBitmap | null,
  opacity: number,
): void {
  const w = Math.max(1, disc.w);
  const h = Math.max(1, disc.h);
  const rect = scaleRect(
    { x: disc.x + (offset.dx / w) * disc.w, y: disc.y + (offset.dy / h) * disc.h, w: (offset.w / w) * disc.w, h: (offset.h / h) * disc.h },
    STAGE_W, STAGE_H, outW, outH,
  );
  ctx.save();
  ctx.globalAlpha = opacity;
  if (bitmap) {
    ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h);
  } else {
    // BLACK piece has no image — solid fill circle, matching `.tb-disc-black`.
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 2, rect.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawDecoLayer(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  layer: DecoLayer,
  outW: number,
  outH: number,
  bitmap: ImageBitmap | null,
): void {
  if (!bitmap) return;
  const rect = scaleRect(layer, STAGE_W, STAGE_H, outW, outH);
  ctx.save();
  if (layer.rot) {
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.rotate((layer.rot * Math.PI) / 180);
    ctx.drawImage(bitmap, -rect.w / 2, -rect.h / 2, rect.w, rect.h);
  } else {
    ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
}

/** Draws a `frame` layer (bundled line-art brackets) tinted toward the hue.
 *  The art is white on transparent: we draw the white bitmap, then overlay the
 *  hue color through `source-atop` at `tint` strength so only the art's pixels
 *  recolor (transparent stays transparent). Mirrors `FrameComposite`. */
function drawFrameLayer(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  layer: FrameLayer,
  outW: number,
  outH: number,
  hue: number,
  bitmap: ImageBitmap | null,
): void {
  if (!bitmap) return;
  const scale = outW / STAGE_W;
  const rect = scaleRect(layer, STAGE_W, STAGE_H, outW, outH);
  const tint = Math.max(0, Math.min(1, layer.tint));

  // Render to an offscreen buffer the size of the layer box so `source-atop`
  // clips the tint to the art's alpha WITHOUT bleeding onto the rest of the
  // poster (a full-canvas source-atop would tint every prior pixel).
  const bw = Math.max(1, Math.round(rect.w));
  const bh = Math.max(1, Math.round(rect.h));
  const buf: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bw, bh) : (() => {
      const c = document.createElement('canvas'); c.width = bw; c.height = bh; return c;
    })();
  const bctx = buf.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!bctx) return;
  // `contain` fit inside the box (matches the preview's objectFit: contain).
  const ar = bitmap.width / bitmap.height;
  const boxAr = bw / bh;
  let dw = bw, dh = bh;
  if (ar > boxAr) { dh = bw / ar; } else { dw = bh * ar; }
  const dx = (bw - dw) / 2, dy = (bh - dh) / 2;
  bctx.drawImage(bitmap, dx, dy, dw, dh);
  if (tint > 0) {
    bctx.globalCompositeOperation = 'source-atop';
    bctx.globalAlpha = tint;
    bctx.fillStyle = resolveGlowColor(hue);
    bctx.fillRect(0, 0, bw, bh);
    bctx.globalAlpha = 1;
    bctx.globalCompositeOperation = 'source-over';
  }

  ctx.save();
  applyLayerShadow(ctx, layer, scale);
  if (layer.rot) {
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.rotate((layer.rot * Math.PI) / 180);
    ctx.drawImage(buf, -rect.w / 2, -rect.h / 2, rect.w, rect.h);
  } else {
    ctx.drawImage(buf, rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
}

function drawTextLayer(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  layer: TextLayer,
  outW: number,
  outH: number,
  preset: ThumbnailPresetId,
  hue: number,
): void {
  const scale = outW / STAGE_W;
  const rect = scaleRect(layer, STAGE_W, STAGE_H, outW, outH);
  const lines = layer.text.split('\n');
  const maxSize = layer.size * scale;
  const measure = canvasMeasureFor(ctx, layer, scale);
  const fitted = fitFontSize(measure, lines, rect.w, rect.h, maxSize);
  // Per-layer treatment: mix from the layer's base (cream or white) toward the
  // hue by the layer's `hueMix` (preset default when undefined). Glow color =
  // the text color, so the hue slider drives both. Mirrors the preview's
  // `resolveTextStyle`.
  const color = resolveTextColorEx(preset, hue, layer.baseColor ?? TEXT_BASE_COLOR, layer.hueMix);
  const glow = resolveTextGlow(color, { glow: layer.glow, glowStrength: layer.glowStrength });

  ctx.save();
  if (layer.rot) {
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.rotate((layer.rot * Math.PI) / 180);
    ctx.translate(-rect.w / 2, -rect.h / 2);
  } else {
    ctx.translate(rect.x, rect.y);
  }

  ctx.font = `${layer.italic ? 'italic ' : ''}800 ${fitted}px ${layer.font}`;
  // Match the live preview's CSS `letter-spacing: <spacing>px` (ThumbnailArtboard's
  // `.tb-body` style) and the measurement above — without this, fillText paints
  // with zero tracking and the export reads tighter than both the preview and
  // the fit computation that reserved room for it.
  ctx.letterSpacing = `${layer.spacing * scale}px`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // Bottom-anchored stack (matches `.tb-el.text .tb-body`'s
  // `justify-content:flex-end` — the LAST line sits at the box's bottom
  // edge, earlier lines stack upward above it). Each line advances by
  // `lineH` (mirrors the CSS `line-height: 1.1`); the first line's baseline
  // is placed so the LAST line's baseline lands `~0.8*fitted` above the
  // box's bottom edge (a reasonable descender allowance for a fillText
  // baseline vs. a flex row's bottom edge).
  const lineH = fitted * TEXT_LINE_HEIGHT;
  const y0 = rect.h - (lines.length - 1) * lineH - (lineH - fitted * 0.8);
  const paint = () => {
    let y = y0;
    for (const line of lines) {
      ctx.fillText(line.length > 0 ? line : ' ', 0, y);
      y += lineH;
    }
  };

  // Colored glow passes (matches the preview's stacked text-shadow glow) —
  // canvas has one shadow at a time, so paint the text twice with the glow
  // color as a wide then tight blurred shadow (centered, behind the fill).
  if (glow) {
    ctx.shadowColor = glow.color;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    for (const mult of [2, 1]) {
      ctx.shadowBlur = glow.blur * mult * scale;
      paint();
    }
  }
  // Legibility drop-shadow + the actual fill.
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 12 * scale;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2 * scale;
  paint();
  // Per-layer cast shadow style (optional), then a final clean fill on top so
  // the glyph edges stay crisp over its own shadow.
  if (layer.shadow) {
    applyLayerShadow(ctx, layer, scale);
    paint();
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  paint();
  ctx.restore();
}


/**
 * Composites the final poster at `opts.outW`x`opts.outH` and returns it as a
 * Blob encoded per `opts.format`. See the module doc comment above for the
 * exact draw order and why it matches the live preview.
 */
export async function composeThumbnail(opts: ComposeOptions): Promise<Blob> {
  const { scene, mapScene, layers, preset, hue, vignette = 0, cornerGlow = 0, outW, outH, format, quality = 0.92 } = opts;

  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(outW, outH) : (() => {
      const c = document.createElement('canvas');
      c.width = outW;
      c.height = outH;
      return c;
    })();
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('composeThumbnail: failed to get 2D context');

  const visible = layers.filter(l => !l.hidden);
  const discLayer = visible.find((l): l is DiscLayer => l.type === 'disc') ?? null;
  const decoBehind = visible.filter((l): l is DecoLayer => l.type === 'deco' && l.z === 'behind');
  const decoFront = visible.filter((l): l is DecoLayer => l.type === 'deco' && l.z === 'front');
  // Text keeps LAYER ARRAY ORDER (visible preserves it); drawn last so text is
  // always on top, in the order the layers appear.
  const textLayers = visible.filter((l): l is TextLayer => l.type === 'text');
  // Frame layers (line-art brackets) — drawn above the models/deco, below text.
  const frameLayers = visible.filter((l): l is FrameLayer => l.type === 'frame');

  // Preload disc bitmaps in parallel before drawing anything.
  const [ringBitmap, glowBitmap] = discLayer
    ? await Promise.all([
        bundledAssetUrl('ring').then(loadImageBitmapFromUrl),
        bundledAssetUrl('glow').then(loadImageBitmapFromUrl),
      ])
    : [null, null];
  // Preload each frame layer's bundled art bitmap (keyed by asset name).
  const frameBitmaps = new Map<string, ImageBitmap>();
  await Promise.all(
    Array.from(new Set(frameLayers.map(f => f.asset))).map(async asset => {
      const bmp = await bundledAssetUrl(asset as ThumbnailAssetName).then(loadImageBitmapFromUrl);
      frameBitmaps.set(asset, bmp);
    }),
  );
  // Ensure the poster font (e.g. Anton) is loaded before any fillText — the
  // OffscreenCanvas 2D context won't wait on `font-display: swap`, so an
  // unloaded face would silently fall back. Load every distinct text font.
  if (typeof document !== 'undefined' && document.fonts) {
    await Promise.all(
      Array.from(new Set(textLayers.map(t => t.font))).map(font =>
        document.fonts.load(`800 40px ${font}`).catch(() => { /* fallback face is fine */ }),
      ),
    );
  }
  // Deco layers: no image is loaded (see the module doc comment's DECO
  // ASSETS note — `deco.asset` isn't rendered by the live preview either,
  // it's a deferred feature), so every deco draw call below is a
  // documented no-op. The z-order slots (behind/front) still exist so
  // wiring the real image loader later is a one-line change here.
  const decoBitmaps = new Map<string, ImageBitmap | null>();

  // The layering now matches the live preview exactly (the scene canvas is
  // TRANSPARENT — only model pixels are opaque — so the disc "circle" is a
  // BACKGROUND separator painted BEHIND the models, and the hero renders on
  // top of it):
  //
  //   1. dark environment backdrop (mirrors the `.tb-env` DOM layer)
  //   2. deco (behind)
  //   3. the full disc: glow + darkened fill + gold ring (the "circle")
  //   4. the model screenshot (transparent bg; models composite over the disc)
  //   5. deco (front)
  //   6. text

  // 1. Environment backdrop — solid dark fill (the `.tb-env` gradient is
  //    cosmetic; a flat dark base matches the composed look closely and is
  //    fully opaque so nothing shows through the final image).
  ctx.save();
  const h = ((hue % 360) + 360) % 360;
  // Diagonal dark base (matches resolveBackground's linear stops).
  const lin = ctx.createLinearGradient(0, 0, outW, outH);
  lin.addColorStop(0, `hsl(${h}, 45%, 12%)`);
  lin.addColorStop(0.42, `hsl(${h}, 55%, 20%)`);
  lin.addColorStop(1, `hsl(${h}, 50%, 7%)`);
  ctx.fillStyle = lin;
  ctx.fillRect(0, 0, outW, outH);
  // Off-center radial glow (matches the radial stop at 64%/42%).
  const cx = outW * 0.64, cy = outH * 0.42;
  const rad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(outW, outH) * 0.52);
  rad.addColorStop(0, `hsla(${h}, 60%, 45%, 0.32)`);
  rad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, outW, outH);
  ctx.restore();

  // 1b. The 3D map backdrop (own scene), drawn behind the disc so the z-order
  //     is map → disc → models. Only present when a visible map env layer
  //     exists and its GLB has loaded.
  const envVisible = visible.some(l => l.type === 'env');
  if (mapScene && envVisible && mapScene.isLoaded()) {
    const mapBlob = await mapScene.screenshot(outW, outH);
    const mapBitmap = await createImageBitmap(mapBlob);
    ctx.drawImage(mapBitmap, 0, 0, outW, outH);
  }

  // 2. Deco behind everything.
  for (const d of decoBehind) drawDecoLayer(ctx, d, outW, outH, decoBitmaps.get(d.id) ?? null);

  const drawDisc = () => {
    if (!discLayer) return;
    // Optional per-layer cast shadow around the whole disc composite. Applied
    // on the ring pass only (the outermost silhouette) so it reads as one
    // shadow rather than stacking under each piece.
    drawDiscPiece(ctx, discLayer, GLOW_OFFSET, outW, outH, glowBitmap, 1);
    drawDiscPiece(ctx, discLayer, BLACK_OFFSET, outW, outH, null, discLayer.opacity / 100);
    if (discLayer.shadow) {
      ctx.save();
      applyLayerShadow(ctx, discLayer, outW / STAGE_W);
      drawDiscPiece(ctx, discLayer, RING_OFFSET, outW, outH, ringBitmap, 1);
      ctx.restore();
    } else {
      drawDiscPiece(ctx, discLayer, RING_OFFSET, outW, outH, ringBitmap, 1);
    }
  };
  // Model drop-shadow: the scene screenshot is transparent except model pixels,
  // so a canvas shadow around the drawn bitmap casts a real silhouette shadow.
  // Mirrors the preview's `filter: drop-shadow` on the shared scene canvas (one
  // plane → the first visible model with `shadow` on drives it).
  const shadowModel = visible.find(l => l.type === 'model' && l.shadow) ?? null;
  const drawModels = async () => {
    const shotBlob = await scene.screenshot(outW, outH);
    const shotBitmap = await createImageBitmap(shotBlob);
    if (shadowModel) {
      ctx.save();
      applyLayerShadow(ctx, shadowModel, outW / STAGE_W);
      ctx.drawImage(shotBitmap, 0, 0, outW, outH);
      ctx.restore();
    } else {
      ctx.drawImage(shotBitmap, 0, 0, outW, outH);
    }
  };

  // 3+4. Disc vs models order follows LAYER ARRAY POSITION (earlier index =
  // front). The shared model canvas is one plane, so the disc goes entirely
  // above or below the model band depending on whether the disc sits before or
  // after the front-most model in the array.
  const discIdx = discLayer ? layers.findIndex(l => l.id === discLayer.id) : Infinity;
  const frontModelIdx = layers.findIndex(l => !l.hidden && l.type === 'model');
  const discInFront = discLayer != null && frontModelIdx >= 0 && discIdx < frontModelIdx;
  if (discInFront) {
    await drawModels();
    drawDisc();
  } else {
    drawDisc();
    await drawModels();
  }

  // 5. Deco in front of the models.
  for (const d of decoFront) drawDecoLayer(ctx, d, outW, outH, decoBitmaps.get(d.id) ?? null);

  // 5a. Frame layers (line-art brackets), tinted toward the hue — above the
  //     models/deco, below the corner glow / vignette / text.
  for (const f of frameLayers) drawFrameLayer(ctx, f, outW, outH, hue, frameBitmaps.get(f.asset) ?? null);

  // 5a2. Bottom-right corner glow — a hue-tinted radial bloom, `screen`-blended
  //      so it adds light (mirrors the live `.tb-corner-glow` overlay).
  if (cornerGlow > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const gx = outW, gy = outH; // bottom-right corner
    const gr = Math.max(outW, outH) * 0.7;
    const cg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    const a = Math.max(0, Math.min(1, cornerGlow / 100)) * 0.75;
    cg.addColorStop(0, hexToRgba(resolveGlowColor(hue), a));
    cg.addColorStop(0.7, hexToRgba(resolveGlowColor(hue), 0));
    ctx.fillStyle = cg;
    ctx.fillRect(0, 0, outW, outH);
    ctx.restore();
  }

  // 5b. Vignette — cinematic edge darkening over the composition, BELOW text so
  //     the title/subtitle stay crisp. Mirrors the live `.tb-vignette` overlay.
  if (vignette > 0) {
    ctx.save();
    const cx = outW / 2, cy = outH / 2;
    const r0 = Math.max(outW, outH) * 0.4;
    const r1 = Math.max(outW, outH) * 0.72;
    const vg = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(0,0,0,${(vignette / 100) * 0.85})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, outW, outH);
    ctx.restore();
  }

  // 6. Text, always last.
  for (const t of textLayers) drawTextLayer(ctx, t, outW, outH, preset, hue);

  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: format, quality });
  }
  // HTMLCanvasElement fallback (non-OffscreenCanvas environments).
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      format,
      quality,
    );
  });
}
