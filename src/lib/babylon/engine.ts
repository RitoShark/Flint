import { Engine } from '@babylonjs/core/Engines/engine';

/**
 * Creates and configures a Babylon.js Engine instance.
 * Enables transparent background to blend natively with the app theme.
 */
export function createEngine(canvas: HTMLCanvasElement): Engine {
    return new Engine(canvas, true, {
        preserveDrawingBuffer: false,
        stencil: false,
        antialias: true,
        adaptToDeviceRatio: true,
        alpha: true,
        premultipliedAlpha: false,
    });
}
