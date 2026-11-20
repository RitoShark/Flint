import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';

export interface SubmeshRange {
    name: string;
    start_vertex: number;
    vertex_count: number;
    start_index: number;
    index_count: number;
    /** Map only: MapModel.layer bitmask encoding the elemental variant. */
    layer?: number;
    /** Map only: the baked-light atlas this submesh's model samples ('' for none). */
    lightmap?: string;
}

export interface MeshDTO {
    positions: Float32Array;
    indices: Uint16Array | Uint32Array;
    normals?: Float32Array;
    uvs: Float32Array;
    colors?: Uint8Array | number[];
    bone_indices?: Uint8Array;
    bone_weights?: Float32Array;
    submeshes: SubmeshRange[];
    bbox: [[number, number, number], [number, number, number]];
}

export interface BuiltMesh {
    meshes: Mesh[];
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

export function buildSknMeshes(
    skn: MeshDTO,
    scene: Scene,
    skeleton?: Skeleton,
    influences?: number[],
): BuiltMesh {
    const meshes: Mesh[] = [];
    const hasSkin =
        !!skeleton &&
        skn.bone_indices &&
        skn.bone_weights &&
        skn.bone_indices.length === (skn.positions.length / 3) * 4 &&
        skn.bone_weights.length === skn.bone_indices.length;

    for (let s = 0; s < skn.submeshes.length; s++) {
        const sm = skn.submeshes[s];
        const vStart = sm.start_vertex;
        const vCount = sm.vertex_count;
        const iStart = sm.start_index;
        const iCount = sm.index_count;

        const positions = new Float32Array(vCount * 3);
        for (let i = 0; i < vCount * 3; i++) {
            positions[i] = skn.positions[vStart * 3 + i];
        }

        // Flip V coordinate (V is at odd indices).
        const uvs = new Float32Array(vCount * 2);
        for (let i = 0; i < vCount * 2; i++) {
            if (i % 2 === 1) {
                uvs[i] = 1.0 - skn.uvs[vStart * 2 + i];
            } else {
                uvs[i] = skn.uvs[vStart * 2 + i];
            }
        }

        /* Rebase the global indices into [0, vCount) so each Babylon mesh has
           self-contained buffers, AND swap each triangle's last two indices.
           League stores the opposite winding from Babylon's convention, so left
           as-is the computed normals point inward and the model renders
           inside-out. Reversing the winding is the WHOLE fix — Babylon's default
           scene is left-handed, same as League, so no axis conversion is wanted
           and negating one would mirror the champion. */
        const indices = new Uint32Array(iCount);
        for (let i = 0; i < iCount; i += 3) {
            indices[i]     = skn.indices[iStart + i]     - vStart;
            indices[i + 1] = skn.indices[iStart + i + 2] - vStart;
            indices[i + 2] = skn.indices[iStart + i + 1] - vStart;
        }

        const normals = new Float32Array(vCount * 3);
        const srcNormals = skn.normals;
        let haveAuthored = !!srcNormals && srcNormals.length >= (vStart + vCount) * 3;
        let degenerate = 0;
        if (haveAuthored && srcNormals) {
            for (let v = 0; v < vCount; v++) {
                const o = v * 3;
                const x = srcNormals[(vStart + v) * 3];
                const y = srcNormals[(vStart + v) * 3 + 1];
                const z = srcNormals[(vStart + v) * 3 + 2];
                const len2 = x * x + y * y + z * z;
                if (!Number.isFinite(len2) || len2 < 1e-12) {
                    degenerate++;
                    continue;
                }
                normals[o] = x;
                normals[o + 1] = y;
                normals[o + 2] = z;
            }
            haveAuthored = degenerate < vCount;
        }
        if (!haveAuthored) {
            VertexData.ComputeNormals(positions, indices, normals);
        } else if (degenerate > 0) {
            const computed = new Float32Array(vCount * 3);
            VertexData.ComputeNormals(positions, indices, computed);
            for (let v = 0; v < vCount; v++) {
                const o = v * 3;
                if (normals[o] !== 0 || normals[o + 1] !== 0 || normals[o + 2] !== 0) continue;
                const cx = computed[o];
                const cy = computed[o + 1];
                const cz = computed[o + 2];
                const ok = Number.isFinite(cx + cy + cz) && cx * cx + cy * cy + cz * cz > 1e-12;
                normals[o] = ok ? cx : 0;
                normals[o + 1] = ok ? cy : 1;
                normals[o + 2] = ok ? cz : 0;
            }
        }

        const vd = new VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.normals = normals;
        vd.uvs = uvs;

        const colors = new Float32Array(vCount * 4);
        if (skn.colors && skn.colors.length >= (vStart + vCount) * 4) {
            for (let i = 0; i < vCount * 4; i++) {
                colors[i] = skn.colors[vStart * 4 + i] / 255;
            }
        } else {
            for (let i = 0; i < vCount; i++) {
                colors[i * 4 + 3] = 1;
            }
        }
        vd.colors = colors;

        if (hasSkin && skn.bone_indices && skn.bone_weights) {
            const matrixIndices: number[] = new Array(vCount * 4);
            const matrixWeights: number[] = new Array(vCount * 4);
            const influenceTable = influences ?? [];
            for (let i = 0; i < vCount * 4; i++) {
                const sknIdx = skn.bone_indices[vStart * 4 + i];
                const boneId =
                    influenceTable.length > sknIdx
                        ? influenceTable[sknIdx]
                        : sknIdx;
                matrixIndices[i] = boneId;
                matrixWeights[i] = skn.bone_weights[vStart * 4 + i];
            }
            vd.matricesIndices = matrixIndices;
            vd.matricesWeights = matrixWeights;
        }

        const meshName = sm.name || `submesh_${s}`;
        const mesh = new Mesh(meshName, scene);
        vd.applyToMesh(mesh);

        if (hasSkin) {
            mesh.skeleton = skeleton!;
            mesh.numBoneInfluencers = 4;
            mesh.alwaysSelectAsActiveMesh = true;
        }
        mesh.sideOrientation = Mesh.DOUBLESIDE;
        mesh.useVertexColors = false;

        let nanPos = 0;
        for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) nanPos++;
        let nanNrm = 0;
        for (let i = 0; i < normals.length; i++) if (!Number.isFinite(normals[i])) nanNrm++;
        console.debug(
            `[meshBuilder] submesh[${s}] srcName='${sm.name}' -> meshName='${meshName}' ` +
            `vCount=${vCount} iCount=${iCount} posLen=${positions.length} idxLen=${indices.length} ` +
            `nanPos=${nanPos} nanNrm=${nanNrm} hasSkin=${!!hasSkin} ` +
            `gpuVerts=${mesh.getTotalVertices()} gpuIdx=${mesh.getTotalIndices()}`
        );

        meshes.push(mesh);
    }

    return {
        meshes,
        bbox: { min: skn.bbox[0], max: skn.bbox[1] },
    };
}
