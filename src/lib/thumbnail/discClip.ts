/**
 * Geometry for clipping a model to the disc's circle.
 *
 * The shape a viewer reads as "the circle" is the disc composite's BLACK FILL,
 * which is NOT the disc layer's own box — it's a fixed offset from it
 * (`BLACK_OFFSET` in `DiscComposite.tsx`), and it is very slightly taller than
 * wide (407 x 412), so this is a true ellipse rather than a circle. Clipping to
 * the layer box, or forcing a circle, would misalign the cut against the gold
 * ring.
 *
 * Both consumers derive their clip from here: the live preview applies a CSS
 * `clip-path` to the model's own canvas, and the export compositor applies the
 * matching `ctx.ellipse()` clip. One source of truth is the point — a duplicated
 * copy of these numbers is exactly how the preview and the exported PNG would
 * drift apart.
 *
 * Kept free of React/DOM imports so it unit-tests in the node environment vitest
 * runs in, matching `sknAlpha.ts` and `cameraFraming.ts`.
 */

import { BLACK_OFFSET } from '../../components/thumbnail/DiscComposite';

/** Just the placement fields this module needs — avoids importing the full
 *  `DiscLayer` type and lets tests build minimal fixtures. */
export interface DiscBox {
    x: number;
    y: number;
    w: number;
    h: number;
    /** Layer rotation in degrees; the fill rotates with the layer. */
    rot?: number;
}

/** An axis-aligned ellipse plus the rotation applied about its own centre. */
export interface ClipEllipse {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    /** Rotation in degrees, about (cx, cy). */
    rot: number;
}

/**
 * The disc's black-fill ellipse in STAGE coordinates.
 *
 * Both `DiscComposite` (CSS percentages) and `drawDiscPiece` (canvas) express
 * the fill as `(offset.dx / layer.w) * layer.w`, which reduces to the raw
 * pixel offset — the fill is a FIXED size and does not scale when the disc box
 * is resized. We compute the reduced form directly so this module states what
 * the geometry actually is; keeping the identity would only invite someone to
 * "fix" one copy and desync the clip from the art.
 */
export function discClipEllipse(disc: DiscBox): ClipEllipse {
    const fillX = disc.x + BLACK_OFFSET.dx;
    const fillY = disc.y + BLACK_OFFSET.dy;
    const fillW = BLACK_OFFSET.w;
    const fillH = BLACK_OFFSET.h;

    return {
        cx: fillX + fillW / 2,
        cy: fillY + fillH / 2,
        rx: fillW / 2,
        ry: fillH / 2,
        rot: disc.rot ?? 0,
    };
}

/** A model layer's box, in stage coordinates. A zero w/h means "fills the
 *  stage", matching the scene's own convention. */
export interface ModelBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Re-express the clip ellipse in a model canvas's LOCAL pixel space, so it can
 * be handed to CSS `clip-path` on that canvas. The model canvas is absolutely
 * positioned at its layer box, so local = stage minus the box origin.
 */
export function discClipInModelSpace(disc: DiscBox, model: ModelBox): ClipEllipse {
    const e = discClipEllipse(disc);
    // A 0-sized box means the model fills the whole stage (scene convention).
    const originX = model.w > 0 ? model.x : 0;
    const originY = model.h > 0 ? model.y : 0;
    return {
        cx: e.cx - originX,
        cy: e.cy - originY,
        rx: e.rx,
        ry: e.ry,
        rot: e.rot,
    };
}

/** Which side of the circle survives a clip. */
export type ClipMode = 'inside' | 'outside';

/** Sample the ellipse outline as points, walking `dir` around it (+1 = CCW in
 *  screen space, -1 = CW). Winding direction matters for the punch-out below. */
function ellipsePoints(e: ClipEllipse, steps: number, dir: 1 | -1): string[] {
    const rad = (e.rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const pts: string[] = [];
    for (let i = 0; i < steps; i += 1) {
        const t = dir * (i / steps) * Math.PI * 2;
        const px = e.rx * Math.cos(t);
        const py = e.ry * Math.sin(t);
        pts.push(`${round(e.cx + px * cos - py * sin)}px ${round(e.cy + px * sin + py * cos)}px`);
    }
    return pts;
}

/**
 * A CSS `clip-path` keeping the region INSIDE the ellipse.
 *
 * Rotation can't be expressed inside `ellipse()`, so a rotated disc falls back
 * to a polygon approximation — visually identical at these sizes, and it avoids
 * rotating the canvas element itself (which would move the model with it).
 */
export function clipPathFor(e: ClipEllipse): string {
    if (Math.abs(e.rot % 360) < 0.01) {
        return `ellipse(${round(e.rx)}px ${round(e.ry)}px at ${round(e.cx)}px ${round(e.cy)}px)`;
    }
    return `polygon(${ellipsePoints(e, 64, 1).join(', ')})`;
}

/**
 * A CSS `clip-path` keeping the region OUTSIDE the ellipse — the complement of
 * `clipPathFor`, for a model staged around the circle rather than within it.
 *
 * CSS `polygon()` uses the NONZERO fill rule, so a hole is punched by winding
 * the inner ring OPPOSITE to the outer rect. (`evenodd` is not available on
 * `clip-path` polygons across browsers, hence the winding trick.) The outer
 * rect spans the model's own box, which is the clip's coordinate space.
 */
export function clipPathOutside(e: ClipEllipse, box: { w: number; h: number }): string {
    const w = Math.max(0, box.w);
    const h = Math.max(0, box.h);
    // Outer rect, clockwise.
    const outer = [`0px 0px`, `${round(w)}px 0px`, `${round(w)}px ${round(h)}px`, `0px ${round(h)}px`];
    // Inner ellipse, counter-clockwise, so nonzero winding cancels to a hole.
    const inner = ellipsePoints(e, 64, -1);
    // Close the outer ring before bridging into the inner one, so the seam
    // between them is a zero-width cut rather than a visible wedge.
    return `polygon(${[...outer, `0px 0px`, ...inner, inner[0]].join(', ')})`;
}

function round(n: number): number {
    return Math.round(n * 100) / 100;
}
