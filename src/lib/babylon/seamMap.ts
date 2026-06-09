/**
 * seamMap.ts — find UV-island seams for cross-seam paint bleed.
 *
 * A "seam" is a mesh edge whose two triangles place it at DIFFERENT spots in UV
 * space (the surface is continuous in 3D but split across the texture). When a
 * brush paints near one side of a seam, we also stamp the mirrored point on the
 * other side so paint continues across the seam on the 3D model.
 *
 * Pure functions, no Babylon/DOM deps (unit-testable in Node).
 */

/** A seam: the same 3D edge, expressed in both islands' UV space.
 *  a0,a1 = the edge endpoints' UVs on side A; b0,b1 = same endpoints on side B.
 *  (a0↔b0 and a1↔b1 are the SAME 3D vertices.) */
export interface Seam {
    a0: [number, number]; a1: [number, number];
    b0: [number, number]; b1: [number, number];
}

/** Quantize a position so float noise doesn't split a shared vertex. */
function posKey(x: number, y: number, z: number): string {
    const q = (v: number) => Math.round(v * 1000) / 1000;
    return `${q(x)},${q(y)},${q(z)}`;
}

/** Undirected edge key from two position keys. */
function edgeKey(pa: string, pb: string): string {
    return pa < pb ? `${pa}|${pb}` : `${pb}|${pa}`;
}

/**
 * Build seams for one texture's geometry.
 * @param positions flat xyz per vertex (the GLOBAL pool)
 * @param uvs flat uv per vertex
 * @param indices triangle indices to consider (this texture's faces only)
 */
export function buildSeams(positions: Float32Array, uvs: Float32Array, indices: Uint32Array | number[]): Seam[] {
    // Map each 3D edge → the list of (uvOfEnd0, uvOfEnd1) occurrences (one per
    // triangle touching it). Also remember which posKey is "end0" so both sides
    // align their endpoints.
    interface Occ { p0: string; uv0: [number, number]; uv1: [number, number]; }
    const edges = new Map<string, Occ[]>();

    const uvAt = (vi: number): [number, number] => [uvs[vi * 2], uvs[vi * 2 + 1]];
    const pkAt = (vi: number): string => posKey(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);

    const tris = indices.length / 3;
    for (let t = 0; t < tris; t++) {
        const v = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
        for (let e = 0; e < 3; e++) {
            const i0 = v[e], i1 = v[(e + 1) % 3];
            const pk0 = pkAt(i0), pk1 = pkAt(i1);
            if (pk0 === pk1) continue; // degenerate
            const key = edgeKey(pk0, pk1);
            // Normalize endpoint order to the edge key's order so both triangles
            // store uv0 for the same physical vertex.
            const flip = !(pk0 < pk1);
            const occ: Occ = flip
                ? { p0: pk1, uv0: uvAt(i1), uv1: uvAt(i0) }
                : { p0: pk0, uv0: uvAt(i0), uv1: uvAt(i1) };
            const arr = edges.get(key);
            if (arr) arr.push(occ); else edges.set(key, [occ]);
        }
    }

    const seams: Seam[] = [];
    const same = (a: [number, number], b: [number, number]) =>
        Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;

    for (const occs of edges.values()) {
        if (occs.length < 2) continue; // border edge, no seam
        // Compare the first two occurrences (shared manifold edges have 2).
        const [A, B] = occs;
        // If both sides have identical UVs, it's not a seam (continuous in UV too).
        if (same(A.uv0, B.uv0) && same(A.uv1, B.uv1)) continue;
        seams.push({ a0: A.uv0, a1: A.uv1, b0: B.uv0, b1: B.uv1 });
    }
    return seams;
}

/** If UV point p lies near seam side A, return the mirrored point on side B
 *  (param t along the edge preserved). null if not near, or near side B already. */
export function mirrorAcrossSeam(p: [number, number], seam: Seam, nearDist: number): [number, number] | null {
    const proj = (s0: [number, number], s1: [number, number]) => {
        const dx = s1[0] - s0[0], dy = s1[1] - s0[1];
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) return null;
        let t = ((p[0] - s0[0]) * dx + (p[1] - s0[1]) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = s0[0] + dx * t, cy = s0[1] + dy * t;
        const dist = Math.hypot(p[0] - cx, p[1] - cy);
        return { t, dist };
    };
    const a = proj(seam.a0, seam.a1);
    if (a && a.dist <= nearDist) {
        return [seam.b0[0] + (seam.b1[0] - seam.b0[0]) * a.t,
                seam.b0[1] + (seam.b1[1] - seam.b0[1]) * a.t];
    }
    const b = proj(seam.b0, seam.b1);
    if (b && b.dist <= nearDist) {
        return [seam.a0[0] + (seam.a1[0] - seam.a0[0]) * b.t,
                seam.a0[1] + (seam.a1[1] - seam.a0[1]) * b.t];
    }
    return null;
}
