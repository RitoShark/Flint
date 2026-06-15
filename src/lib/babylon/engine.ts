import { Engine } from '@babylonjs/core/Engines/engine';

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
