import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { MeshGeometry, Pose } from '../types';
import { SkinPalette } from '../skinning';
import { nameHash } from '../../binHash';
import type { EmissionSurfaceModel } from '../../engine/model/model';
import type { EmissionSampler } from '../../engine/simulation/emissionSurface';
import { drawnIndices } from './submeshes';

export function meshSurface(model: EmissionSurfaceModel, mesh: MeshGeometry, pose: Pose | null): EmissionSampler {
    const indices = drawnIndices(mesh, model.submeshes, []);
    const count = Math.floor(indices.length / 3);
    const points = [Vector3.Zero(), Vector3.Zero(), Vector3.Zero()];
    const edgeA = Vector3.Zero();
    const edgeB = Vector3.Zero();
    const point = Vector3.Zero();
    const normal = Vector3.Zero();
    const skin = pose ? new SkinPalette(pose) : null;
    return {
        sample(time, random, output) {
            if (!count) return false;
            skin?.sample(time);
            const triangle = Math.min(count - 1, Math.floor(random.unitFloat() * count));
            for (let corner = 0; corner < 3; corner++) {
                const index = indices[triangle * 3 + corner];
                if (index * 3 + 2 >= mesh.positions.length) return false;
                if (skin) skin.vertexInto(mesh, index, model.maxJointWeights, points[corner]);
                else Vector3.FromArrayToRef(mesh.positions, index * 3, points[corner]);
            }
            const root = Math.sqrt(random.unitFloat());
            const along = random.unitFloat();
            points[0].scaleToRef(1 - root, point);
            points[1].scaleAndAddToRef(root * (1 - along), point);
            points[2].scaleAndAddToRef(root * along, point);
            point.scaleInPlace(model.scale).toArray(output.position);
            points[1].subtractToRef(points[0], edgeA);
            points[2].subtractToRef(points[0], edgeB);
            Vector3.CrossToRef(edgeA, edgeB, normal);
            normal.normalize().toArray(output.normal);
            return true;
        },
    };
}

export function skeletonSurface(model: EmissionSurfaceModel, pose: Pose): EmissionSampler {
    const included = new Set(model.joints);
    const segments = pose.bones.flatMap((bone, index) => pose.parents[index] >= 0 && (!included.size || included.has(nameHash(bone.name))) ? [index] : []);
    const positions = pose.bones.map(() => Vector3.Zero());
    const cumulative = new Float64Array(segments.length);
    const point = Vector3.Zero();
    let time = NaN;
    let total = 0;
    return {
        sample(now, random, output) {
            if (now !== time) {
                pose.sample(now);
                positions.forEach((position, index) => pose.worldMatrix(index).getTranslationToRef(position));
                total = 0;
                segments.forEach((bone, index) => { total += Vector3.Distance(positions[bone], positions[pose.parents[bone]]); cumulative[index] = total; });
                time = now;
            }
            if (!(total > 0)) return false;
            const target = random.unitFloat() * total;
            let lo = 0;
            let hi = segments.length - 1;
            while (lo < hi) {
                const middle = (lo + hi) >>> 1;
                if (target >= cumulative[middle]) lo = middle + 1;
                else hi = middle;
            }
            const bone = segments[lo];
            const parent = positions[pose.parents[bone]];
            Vector3.LerpToRef(parent, positions[bone], random.unitFloat(), point);
            point.scaleInPlace(model.scale).toArray(output.position);
            positions[bone].subtractToRef(parent, point);
            point.normalize().toArray(output.normal);
            return true;
        },
    };
}
