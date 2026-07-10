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
 * `.tb-env` and the disc's back pieces (glow + black fill) wherever the
 * canvas has pixels (everywhere) — those two pieces are invisible in the
 * live preview as it stands. (A future task wiring a real `env` layer image
 * through `setEnvImage` would flip the scene to a transparent clear color
 * and make them visible — out of scope here; see the `env` layer type that
 * already exists in `layers.ts` but has no UI yet.)
 *
 * So the draw order that reproduces the CURRENT preview pixel-for-pixel is:
 *   1. Scene screenshot (opaque — already includes the dark background AND
 *      the model; this alone already covers where `.tb-env` / disc-back
 *      would have shown through, matching today's preview exactly)
 *   2. Disc back pieces (glow + black fill) — kept for forward-compat with
 *      the day `.tb-env`/scene transparency is wired up; painted here even
 *      though they're currently fully hidden by (1), so this function's
 *      z-order is future-proof rather than silently dependent on the
 *      opaque-clearColor detail elsewhere.
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
 * conceptually the back pieces belong "behind" the model. This is
 * deliberately a no-op today (fully opaque screenshot = nothing shows
 * through), matching the live preview exactly; it stops being a no-op only
 * once the scene gains a real transparent background (see the `.tb-env`
 * paragraph above). Documented so nobody "fixes" the ordering later without
 * re-reading this comment.
 */

import type { Layer, TextLayer, DiscLayer, DecoLayer } from './layers';
import type { ThumbnailScene } from './studioScene';
import { fitFontSize, type TextMeasure } from './textFit';
import { resolveTextColor, type ThumbnailPresetId } from './hue';
import { loadThumbnailAsset } from '../api/thumbnail';

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
  /** Full layer stack, in the SAME order as `history.get()` — z-order is
   *  derived internally the same way the artboard derives it (via zrank),
   *  hidden layers are skipped. */
  layers: Layer[];
  preset: ThumbnailPresetId;
  hue: number;
  outW: number;
  outH: number;
  format: ExportFormat;
  /** Quality for lossy formats (webp/jpeg), 0-1. Defaults to 0.92. */
  quality?: number;
}

let ringUrlPromise: Promise<string> | null = null;
let glowUrlPromise: Promise<string> | null = null;

/** Loads the bundled ring/glow WebP assets as object URLs, cached at module
 *  scope (mirrors `DiscComposite.tsx`'s own cache — this module can't reuse
 *  that one directly since it's private to the component file, but the
 *  underlying `loadThumbnailAsset` fetch is the same call). */
function discAssetUrl(name: 'ring' | 'glow'): Promise<string> {
  if (name === 'ring') {
    if (!ringUrlPromise) {
      ringUrlPromise = loadThumbnailAsset('ring').then(bytes => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/webp' })));
    }
    return ringUrlPromise;
  }
  if (!glowUrlPromise) {
    glowUrlPromise = loadThumbnailAsset('glow').then(bytes => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/webp' })));
  }
  return glowUrlPromise;
}

async function loadImageBitmapFromUrl(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function canvasMeasureFor(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, layer: TextLayer, scale: number): TextMeasure {
  return (text: string, size: number) => {
    ctx.font = `${layer.italic ? 'italic ' : ''}800 ${size}px ${layer.font}`;
    const w = ctx.measureText(text).width + Math.max(0, text.length - 1) * layer.spacing * scale;
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
  const color = resolveTextColor(preset, hue, TEXT_BASE_COLOR);

  ctx.save();
  if (layer.rot) {
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.rotate((layer.rot * Math.PI) / 180);
    ctx.translate(-rect.w / 2, -rect.h / 2);
  } else {
    ctx.translate(rect.x, rect.y);
  }

  ctx.font = `${layer.italic ? 'italic ' : ''}800 ${fitted}px ${layer.font}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 12 * scale;
  ctx.shadowOffsetY = 2 * scale;

  // Bottom-anchored stack (matches `.tb-el.text .tb-body`'s
  // `justify-content:flex-end` — the LAST line sits at the box's bottom
  // edge, earlier lines stack upward above it). Each line advances by
  // `lineH` (mirrors the CSS `line-height: 1.1`); the first line's baseline
  // is placed so the LAST line's baseline lands `~0.8*fitted` above the
  // box's bottom edge (a reasonable descender allowance for a fillText
  // baseline vs. a flex row's bottom edge).
  const lineH = fitted * TEXT_LINE_HEIGHT;
  let y = rect.h - (lines.length - 1) * lineH - (lineH - fitted * 0.8);
  for (const line of lines) {
    ctx.fillText(line.length > 0 ? line : ' ', 0, y);
    y += lineH;
  }
  ctx.restore();
}

function zrank(layer: Layer): number {
  switch (layer.type) {
    case 'disc': return 20;
    case 'model': return 40;
    case 'deco': return layer.z === 'behind' ? 12 : 65;
    case 'text': return 80;
    default: return 50;
  }
}

/**
 * Composites the final poster at `opts.outW`x`opts.outH` and returns it as a
 * Blob encoded per `opts.format`. See the module doc comment above for the
 * exact draw order and why it matches the live preview.
 */
export async function composeThumbnail(opts: ComposeOptions): Promise<Blob> {
  const { scene, layers, preset, hue, outW, outH, format, quality = 0.92 } = opts;

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
  const textLayers = visible.filter((l): l is TextLayer => l.type === 'text').sort((a, b) => zrank(a) - zrank(b));

  // Preload disc bitmaps in parallel before drawing anything.
  const [ringBitmap, glowBitmap] = discLayer
    ? await Promise.all([
        discAssetUrl('ring').then(loadImageBitmapFromUrl),
        discAssetUrl('glow').then(loadImageBitmapFromUrl),
      ])
    : [null, null];
  // Deco layers: no image is loaded (see the module doc comment's DECO
  // ASSETS note — `deco.asset` isn't rendered by the live preview either,
  // it's a deferred feature), so every deco draw call below is a
  // documented no-op. The z-order slots (behind/front) still exist so
  // wiring the real image loader later is a one-line change here.
  const decoBitmaps = new Map<string, ImageBitmap | null>();

  // 1. Scene screenshot (model + baked-in background) — the base of the
  //    composite. See module doc comment for why this alone already
  //    matches the live preview's env/disc-back layering today.
  const shotBlob = await scene.screenshot(outW, outH);
  const shotBitmap = await createImageBitmap(shotBlob);
  ctx.drawImage(shotBitmap, 0, 0, outW, outH);

  // 2. Disc back pieces (glow, then black fill) — forward-compat, see doc.
  if (discLayer) {
    drawDiscPiece(ctx, discLayer, GLOW_OFFSET, outW, outH, glowBitmap, 1);
    drawDiscPiece(ctx, discLayer, BLACK_OFFSET, outW, outH, null, discLayer.opacity / 100);
  }

  // 3. Deco layers behind the model/ring.
  for (const d of decoBehind) drawDecoLayer(ctx, d, outW, outH, decoBitmaps.get(d.id) ?? null);

  // 4. Disc ring (front band).
  if (discLayer) drawDiscPiece(ctx, discLayer, RING_OFFSET, outW, outH, ringBitmap, 1);

  // 5. Deco layers in front.
  for (const d of decoFront) drawDecoLayer(ctx, d, outW, outH, decoBitmaps.get(d.id) ?? null);

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
