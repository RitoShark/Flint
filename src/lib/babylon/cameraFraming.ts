/**
 * Camera framing for the model preview.
 *
 * Extracted from ModelPreview's mesh-load effect, where it was inline and
 * therefore callable exactly once per model. Pulling it out gives two things: a
 * keybinding can re-frame on demand, and a model that loads with a degenerate
 * bounding box stops being stuck badly framed for the rest of the session.
 *
 * The math is kept free of Babylon types so it can be unit-tested in the node
 * environment vitest runs in.
 */

/** Canonical three-quarter view the preview opens on. */
export const HOME_ALPHA = Math.PI / 2 + Math.PI / 8;
export const HOME_BETA = Math.PI / 3;

/**
 * Height is weighted above the horizontal extents because League silhouettes are
 * frequently tall and winged; framing on the largest raw dimension clips them.
 */
const HEIGHT_WEIGHT = 1.4;

export type BoundingBox = [[number, number, number], [number, number, number]];

export interface Framing {
    center: [number, number, number];
    radius: number;
    alpha: number;
    beta: number;
    lowerRadiusLimit: number;
    upperRadiusLimit: number;
    wheelPrecision: number;
    pinchPrecision: number;
    panningSensibility: number;
    speed: number;
}

export function computeFraming(boundingBox: BoundingBox): Framing {
    let [[minX, minY, minZ], [maxX, maxY, maxZ]] = boundingBox;

    const valid =
        [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) &&
        maxX >= minX && maxY >= minY && maxZ >= minZ;

    if (!valid) {
        // Unit box rather than bailing out: a broken bbox must still yield a usable
        // camera, or the model is unviewable.
        minX = minY = minZ = -1;
        maxX = maxY = maxZ = 1;
    }

    const center: [number, number, number] = [
        (minX + maxX) / 2,
        (minY + maxY) / 2,
        (minZ + maxZ) / 2,
    ];

    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;
    const radius = Math.max(sizeY * HEIGHT_WEIGHT, sizeX, sizeZ, 0.01) || 5;

    return {
        center,
        radius,
        alpha: HOME_ALPHA,
        beta: HOME_BETA,
        // Scale-aware limits and control speeds keyed off the framed radius, so a
        // model of any size stays orbitable. The generous upper limit keeps a tiny
        // or bad bbox from trapping the camera.
        lowerRadiusLimit: radius * 0.02,
        upperRadiusLimit: radius * 50.0,
        wheelPrecision: 80 / radius,
        pinchPrecision: 160 / radius,
        panningSensibility: 8000 / Math.max(radius, 0.001),
        speed: radius * 0.02,
    };
}

/** Minimal shape of the bits of ArcRotateCamera framing touches. */
export interface FramableCamera {
    target: unknown;
    radius: number;
    alpha: number;
    beta: number;
    lowerRadiusLimit: number | null;
    upperRadiusLimit: number | null;
    wheelPrecision: number;
    pinchPrecision: number;
    panningSensibility: number;
    speed: number;
}

/**
 * Push a framing onto a camera.
 *
 * `makeTarget` builds the engine's vector type, so this module never imports
 * Babylon and stays testable.
 */
export function applyFraming<C extends FramableCamera>(
    camera: C,
    framing: Framing,
    makeTarget: (x: number, y: number, z: number) => unknown,
    options: { orientation?: boolean } = {},
): void {
    const { orientation = true } = options;

    camera.target = makeTarget(...framing.center);
    camera.radius = framing.radius;
    camera.lowerRadiusLimit = framing.lowerRadiusLimit;
    camera.upperRadiusLimit = framing.upperRadiusLimit;
    camera.wheelPrecision = framing.wheelPrecision;
    camera.pinchPrecision = framing.pinchPrecision;
    camera.panningSensibility = framing.panningSensibility;
    camera.speed = framing.speed;

    // Skipped when restoring a persisted camera, which supplies its own angles.
    if (orientation) {
        camera.alpha = framing.alpha;
        camera.beta = framing.beta;
    }
}
