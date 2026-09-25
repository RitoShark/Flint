import type { EmitterModel } from '../../engine/model/model';
import type { Pool } from '../../engine/simulation/pool';
import { COLOR_LOOKUP } from '../../engine/model/enums';
export function colorLookupInto(emitter: EmitterModel, pool: Pool, index: number, progress: number, output: Float32Array, offset: number): void {
    [emitter.lookupX, emitter.lookupY].forEach((mode, axis) => {
        const input = mode === COLOR_LOOKUP.lifetime ? progress : mode === COLOR_LOOKUP.birthRandom ? pool.roll[index]
            : mode === COLOR_LOOKUP.velocity ? Math.hypot(...pool.travel.subarray(index * 3, index * 3 + 3)) : null;
        output[offset + axis] = emitter.lookupScales[axis] * (input ?? 1) + (input === null ? 0 : emitter.lookupOffsets[axis]);
    });
}
