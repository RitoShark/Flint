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
}

export interface MeshDTO {
    positions: Float32Array;
    indices: Uint16Array | Uint32Array;
    normals?: Float32Array;
    uvs: Float32Array;
    bone_indices?: Uint8Array;
    bone_weights?: Float32Array;
    submeshes: SubmeshRange[];
    bbox: [[number, number, number], [number, number, number]];
}

export interface BuiltMesh {
    meshes: Mesh[];
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Convert raw SKN/SCB data into Babylon.js meshes.
 * Corrects winding order and UV coordinates for Babylon.js.
 */
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

        // Slice submesh vertex positions
        const positions = new Float32Array(vCount * 3);
        for (let i = 0; i < vCount * 3; i++) {
            positions[i] = skn.positions[vStart * 3 + i];
        }

        // Slice UVs and flip V coordinate (V is at odd indices)
        const uvs = new Float32Array(vCount * 2);
        for (let i = 0; i < vCount * 2; i++) {
            if (i % 2 === 1) {
                uvs[i] = 1.0 - skn.uvs[vStart * 2 + i];
            } else {
                uvs[i] = skn.uvs[vStart * 2 + i];
            }
        }

        // Rebase the global indices into [0, vCount) range.
        // NOTE: Do NOT swap winding order here. Our Rust backend already negates
        // the X axis (mirrorX transform on line 117 of skn.rs) to convert League's
        // coordinate system. A mirror on one axis automatically reverses triangle
        // winding — so swapping i+1/i+2 here would double-invert and leave normals
        // pointing inward. Jade's backend sends raw coords and needs the swap;
        // ours does not.
        const indices = new Uint32Array(iCount);
        for (let i = 0; i < iCount; i += 3) {
            indices[i]     = skn.indices[iStart + i]     - vStart;
            indices[i + 1] = skn.indices[iStart + i + 1] - vStart;
            indices[i + 2] = skn.indices[iStart + i + 2] - vStart;
        }

        // Compute normals dynamically — far more reliable than trusting the source
        // file's normals (Riot's exporter is known to produce bad normals).
        // The winding flip above (swap i+1/i+2) already causes ComputeNormals to
        // produce outward-pointing normals via the correct cross-product direction.
        // DO NOT negate afterwards — that would flip them back inward.
        const normals = new Float32Array(vCount * 3);
        VertexData.ComputeNormals(positions, indices, normals);

        const vd = new VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.normals = normals;
        vd.uvs = uvs;

        // Skinning indices/weights mapping to skeleton bone IDs
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
        }
        mesh.sideOrientation = Mesh.DOUBLESIDE;

        // ── DIAGNOSTIC: prove the geometry actually reached the GPU. A renamed
        // submesh (empty source name → `submesh_N`), NaN positions, or a zero
        // vertex count all produce an invisible mesh that still "builds OK".
        let nanPos = 0;
        for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) nanPos++;
        let nanNrm = 0;
        for (let i = 0; i < normals.length; i++) if (!Number.isFinite(normals[i])) nanNrm++;
        console.log(
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
