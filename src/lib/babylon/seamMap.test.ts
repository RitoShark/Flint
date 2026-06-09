import { describe, it, expect } from 'vitest';
import { buildSeams, mirrorAcrossSeam } from './seamMap';

// A true UV seam needs DUPLICATED vertices: the shared 3D edge's endpoints exist
// twice (same position, different UV) so each triangle references its own copy.
// 3D positions of the shared edge: P1(1,0,0), P2(0,1,0).
//   Side A verts: v0=P0(0,0,0)@uv(0,0)  v1=P1@uv(1,0)  v2=P2@uv(0,1)
//   Side B verts: v3=P1@uv(0,0)  v4=P3(1,1,0)@uv(1,1)  v5=P2@uv(0.5,0.5)
//   tri A = v0,v1,v2   tri B = v3,v4,v5   (B's edge v3..v5 == 3D edge P1..P2)
const positions = new Float32Array([
    0, 0, 0,   1, 0, 0,   0, 1, 0,   // v0,v1,v2 (side A)
    1, 0, 0,   1, 1, 0,   0, 1, 0,   // v3(P1),v4(P3),v5(P2) (side B)
]);
const uvs = new Float32Array([
    0.0, 0.0,   1.0, 0.0,   0.0, 1.0,   // side A UVs
    0.0, 0.0,   1.0, 1.0,   0.5, 0.5,   // side B UVs (P1,P2 differ from side A)
]);
const indices = new Uint32Array([0, 1, 2,  3, 4, 5]);

describe('buildSeams', () => {
    it('finds the shared 3D edge with differing UVs as one seam', () => {
        const seams = buildSeams(positions, uvs, indices);
        expect(seams.length).toBe(1);
    });
    it('reports no seam when both sides share the same UVs', () => {
        // Side B's shared-edge verts (v3=P1, v5=P2) reuse side A's UVs → no seam.
        const uvs2 = new Float32Array([
            0.0, 0.0,   1.0, 0.0,   0.0, 1.0,   // side A
            1.0, 0.0,   1.0, 1.0,   0.0, 1.0,   // side B: P1=(1,0), P2=(0,1) match A
        ]);
        const seams = buildSeams(positions, uvs2, indices);
        expect(seams.length).toBe(0);
    });
});

describe('mirrorAcrossSeam', () => {
    it('maps a point near side A to the matching spot on side B', () => {
        const seams = buildSeams(positions, uvs, indices);
        const seam = seams[0];
        // Pick the midpoint of side A; mirror should be the midpoint of side B.
        const aMid: [number, number] = [(seam.a0[0] + seam.a1[0]) / 2, (seam.a0[1] + seam.a1[1]) / 2];
        const m = mirrorAcrossSeam(aMid, seam, 0.01);
        expect(m).not.toBeNull();
        const bMid = [(seam.b0[0] + seam.b1[0]) / 2, (seam.b0[1] + seam.b1[1]) / 2];
        expect(m![0]).toBeCloseTo(bMid[0]);
        expect(m![1]).toBeCloseTo(bMid[1]);
    });
    it('returns null when the point is far from the seam', () => {
        const seams = buildSeams(positions, uvs, indices);
        expect(mirrorAcrossSeam([5, 5], seams[0], 0.01)).toBeNull();
    });
});
