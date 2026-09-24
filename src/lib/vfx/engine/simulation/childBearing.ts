import { INHERIT } from '../model/enums';
import type { EmitterModel, InheritanceModel } from '../model/model';
import { multiplyInto, turnInto, unscaleInto } from '../utils/basis';
import { sampleCurveInto } from '../utils/sampleCurve';
import type { Child } from './children';
import { drawnPlace, drawnPlaceInto, particleBasisInto, standingFrameInto, type DrawFrame, type Source } from './particleRead';

export interface Bearing { readonly place: Float32Array; readonly yaw: Float32Array }
export interface Seen extends Bearing { emitter: number; lifetime: number }
const bearing = (): Bearing => ({place: new Float32Array(3), yaw: new Float32Array(9)});
export const BEARING = bearing();
export function seenAt(emitter: number): Seen { return {...bearing(), emitter, lifetime: 0}; }
export function copySeen(state: Seen): Seen {
    return {emitter: state.emitter, lifetime: state.lifetime, place: Float32Array.from(state.place), yaw: Float32Array.from(state.yaw)};
}

const draw = drawnPlace();
const rotation = new Float32Array(9);
const scale = new Float32Array(3);
const offset = new Float32Array(3);
const jointBasis = new Float32Array(9);

function orient(parent: Source, emitter: EmitterModel, frame: DrawFrame, index: number, local: boolean, output: Float32Array): void {
    if (local) particleBasisInto(parent.pool, index, emitter, frame, rotation);
    else standingFrameInto(parent.pool, index, emitter, frame, rotation);
    if (draw.orbited) multiplyInto(draw.turn, rotation, rotation);
    unscaleInto(rotation, 0, output, 0, scale);
}

export function bearingInto(parent: Source, emitter: EmitterModel, frame: DrawFrame, index: number, inheritance: InheritanceModel | null, output: Bearing): void {
    drawnPlaceInto(parent.pool, index, frame, draw);
    output.place.set(draw.place);
    const mode = inheritance?.mode ?? 0;
    const localOffset = !(mode & INHERIT.ignoreLocalOnOffset);
    const localChild = !(mode & INHERIT.ignoreLocalOnChild);
    orient(parent, emitter, frame, index, localOffset || localChild, output.yaw);
    if (inheritance) {
        offset.fill(0);
        sampleCurveInto(inheritance.offset, 0, offset, 0);
        if (localOffset) turnInto(output.yaw, offset, 0);
        for (let axis = 0; axis < 3; axis++) output.place[axis] += offset[axis];
    }
    if (localOffset && !localChild) orient(parent, emitter, frame, index, false, output.yaw);
}

export function standAt(child: Child, placement: Bearing, now: number): void {
    child.yaw.set(placement.yaw);
    offset.fill(0);
    if (child.anchor) {
        offset.set(child.anchor.originAt(now));
        turnInto(placement.yaw, offset, 0);
        child.anchor.basisInto(now, jointBasis);
        multiplyInto(placement.yaw, jointBasis, child.yaw);
    }
    for (let axis = 0; axis < 3; axis++) child.origin[axis] = placement.place[axis] + offset[axis] + child.world.offset[axis];
    multiplyInto(child.world.basis, child.yaw, child.orientation);
}
