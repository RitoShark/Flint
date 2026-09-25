import type { EmitterModel, PaletteModel } from '../../engine/model/model';
import { frameOf, type Source } from '../../engine/simulation/particleRead';
import { sampleCurve } from '../../engine/utils/sampleCurve';
export const drawsPalette = (palette: PaletteModel | null): palette is PaletteModel => !!palette && palette.count > 0;
export const paletteRow = (palette: PaletteModel) => ((sampleCurve(palette.selector, 0)[0] ?? 0) + .5) / palette.count;
export function paletteScrollInto(palette: PaletteModel, time: number, output: number[]): void {
    [palette.scrollU, palette.scrollV].forEach((curve, axis) => { output[axis] = sampleCurve(curve, time)[0] ?? 0; });
}
export function sourcesScrollInto(emitter: EmitterModel, sources: readonly Source[], output: number[]): void {
    if (emitter.palette && sources.length) paletteScrollInto(emitter.palette, frameOf(sources[0], emitter).phase, output);
}
