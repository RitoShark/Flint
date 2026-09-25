import { expect, it } from 'vitest';
import type { MeshGeometry } from './types';
import { geometryOf } from './geometry';
import { nameHash } from '../binHash';
it('converts selected native mesh ranges without changing the source arrays', () => {
    const mesh: MeshGeometry = {
        positions: Float32Array.of(2, 0, 0, 4, 0, 0, 2, 3, 0), normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
        indices: Uint32Array.of(0, 1, 2, 2, 1, 0), uvs: Float32Array.of(0, 0, 1, 0, 0, 1), skinIndices: null, skinWeights: null,
        ranges: [{ name: 'front', startIndex: 0, indexCount: 3 }, { name: 'back', startIndex: 3, indexCount: 3 }],
    };
    const before = structuredClone(mesh);
    const geometry = geometryOf(mesh, { submeshes: [nameHash('front')], submeshesAlways: [] });
    expect(mesh).toEqual(before);
    expect(Array.from(geometry.index.array)).toEqual([0, 2, 1]);
    expect(Array.from(geometry.attributes.position.array)).toEqual([-2, 0, 0, -4, 0, 0, -2, 3, 0]);
    expect(geometry.attributes.uv.array).toEqual(mesh.uvs);
    expect(geometry.attributes.normal.getZ(0)).toBe(1);
    const generated = geometryOf({ ...mesh, normals: null, uvs: null }, { submeshes: [], submeshesAlways: [] });
    expect(generated.attributes.normal.count).toBe(3);
    expect(generated.attributes.uv.count).toBe(3);
    expect(Array.from(generated.attributes.normal.array).every(Number.isFinite)).toBe(true);
});
