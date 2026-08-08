import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3, Color3, Color4, Matrix, Quaternion } from '@babylonjs/core/Maths/math';
import type { Scene } from '@babylonjs/core/scene';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Bone } from '@babylonjs/core/Bones/bone';

const _IDENTITY_QUAT = Quaternion.Identity();

// Riot's ELF hash variant for case-insensitive bone name hashing
export function elfHash(name: string): number {
    let hash = 0;
    const lowerName = name.toLowerCase();
    for (let i = 0; i < lowerName.length; i++) {
        hash = ((hash << 4) + lowerName.charCodeAt(i)) >>> 0;
        const high = hash & 0xF0000000;
        if (high !== 0) {
            hash ^= high >>> 24;
        }
        hash &= ~high;
    }
    return hash >>> 0;
}

export interface BoneData {
    name: string;
    id: number;
    parent_id: number;
    local_translation: [number, number, number];
    local_rotation: [number, number, number, number];
    local_scale: [number, number, number];
    world_position: [number, number, number];
}

export interface SklData {
    name: string;
    asset_name: string;
    bones: BoneData[];
    influences: number[];
}

export interface BuiltSkeleton {
    lines: LinesMesh;
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

export function buildSkeletonLines(
    skl: SklData,
    scene: Scene,
    options?: {
        color?: Color3;
        name?: string;
    },
): BuiltSkeleton | null {
    const bones = skl.bones;
    if (bones.length === 0) return null;

    const lines: Vector3[][] = [];
    const colors: Color4[][] = [];
    const baseColor = options?.color ?? new Color3(0.55, 0.85, 1.0);
    const segColor = new Color4(baseColor.r, baseColor.g, baseColor.b, 1.0);

    for (const bone of bones) {
        if (bone.parent_id < 0) continue;
        const parent = bones.find(b => b.id === bone.parent_id);
        if (!parent) continue;
        lines.push([
            new Vector3(...parent.world_position),
            new Vector3(...bone.world_position),
        ]);
        colors.push([segColor, segColor]);
    }

    const linesMesh = CreateLineSystem(
        options?.name ?? 'skeleton',
        { lines, colors, useVertexAlpha: false, updatable: false },
        scene,
    );

    linesMesh.renderingGroupId = 1;
    linesMesh.isPickable = false;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of bones) {
        const [x, y, z] = b.world_position;
        if (Number.isFinite(x)) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
        }
        if (Number.isFinite(y)) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        if (Number.isFinite(z)) {
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
    }
    const finite = (n: number) => (Number.isFinite(n) ? n : 0);
    return {
        lines: linesMesh,
        bbox: {
            min: [finite(minX), finite(minY), finite(minZ)],
            max: [finite(maxX), finite(maxY), finite(maxZ)],
        },
    };
}

export interface BuiltMayaSkeleton {
    meshes: Mesh[];
    jointRadius: number;
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

function jointBounds(bones: BoneData[]): { min: [number, number, number]; max: [number, number, number] } {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const b of bones) {
        for (let a = 0; a < 3; a++) {
            const v = b.world_position[a];
            if (!Number.isFinite(v)) continue;
            if (v < lo[a]) lo[a] = v;
            if (v > hi[a]) hi[a] = v;
        }
    }
    const finite = (n: number) => (Number.isFinite(n) ? n : 0);
    return {
        min: [finite(lo[0]), finite(lo[1]), finite(lo[2])],
        max: [finite(hi[0]), finite(hi[1]), finite(hi[2])],
    };
}

export function jointMarkerRadius(bones: BoneData[]): number {
    const { min, max } = jointBounds(bones);
    const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    return Math.max(0.04, diagonal * 0.0048);
}

const BONE_TRIS: ReadonlyArray<readonly [number, number, number]> = [
    [0, 2, 1],
    [0, 3, 2],
    [0, 4, 3],
    [0, 1, 4],
    [5, 1, 2],
    [5, 2, 3],
    [5, 3, 4],
    [5, 4, 1],
];

/**
 * Maya's joint display: a sphere on every joint plus a tapered four-sided bone running from each
 * joint to its parent. Bone width comes from the marker radius, not the bone's own length — scaling
 * it by length (as an isolated octahedron would) makes long bones balloon and short ones vanish.
 */
export function buildSkeletonMaya(
    skl: SklData,
    scene: Scene,
    options?: { boneColor?: Color3; jointColor?: Color3; name?: string },
): BuiltMayaSkeleton | null {
    const bones = skl.bones;
    if (bones.length === 0) return null;

    const name = options?.name ?? 'skeleton-maya';
    const bbox = jointBounds(bones);
    const radius = jointMarkerRadius(bones);
    const meshes: Mesh[] = [];

    const boneById = new Map<number, BoneData>();
    for (const b of bones) boneById.set(b.id, b);

    const positions: number[] = [];
    const indices: number[] = [];

    const head = new Vector3();
    const tail = new Vector3();
    const dir = new Vector3();
    const right = new Vector3();
    const up = new Vector3();
    const upRef = new Vector3(0, 1, 0);
    const upRefAlt = new Vector3(1, 0, 0);

    for (const bone of bones) {
        if (bone.parent_id < 0) continue;
        const parent = boneById.get(bone.parent_id);
        if (!parent) continue;

        head.set(...parent.world_position);
        tail.set(...bone.world_position);
        dir.copyFrom(tail).subtractInPlace(head);
        const length = dir.length();
        if (length < radius * 0.5) continue;
        dir.scaleInPlace(1 / length);

        const ref = Math.abs(Vector3.Dot(dir, upRef)) > 0.9 ? upRefAlt : upRef;
        Vector3.CrossToRef(ref, dir, right);
        right.normalize();
        Vector3.CrossToRef(dir, right, up);
        up.normalize();

        const width = Math.min(radius * 1.15, length * 0.28);
        const ringY = Math.min(width * 1.6, length * 0.3);

        const baseIndex = positions.length / 3;
        const pushVert = (lx: number, ly: number, lz: number) => {
            positions.push(
                head.x + lx * right.x + ly * dir.x + lz * up.x,
                head.y + lx * right.y + ly * dir.y + lz * up.y,
                head.z + lx * right.z + ly * dir.z + lz * up.z,
            );
        };

        pushVert(0, 0, 0);
        pushVert(width, ringY, 0);
        pushVert(0, ringY, width);
        pushVert(-width, ringY, 0);
        pushVert(0, ringY, -width);
        pushVert(0, length, 0);

        for (const [a, b, c] of BONE_TRIS) {
            indices.push(baseIndex + a, baseIndex + b, baseIndex + c);
        }
    }

    if (positions.length > 0) {
        const normals: number[] = [];
        VertexData.ComputeNormals(positions, indices, normals);

        const vd = new VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.normals = normals;

        const boneMesh = new Mesh(`${name}-bones`, scene);
        vd.applyToMesh(boneMesh);
        boneMesh.isPickable = false;

        const boneColor = options?.boneColor ?? new Color3(0.78, 0.79, 0.84);
        const boneMat = new StandardMaterial(`${name}-bones-mat`, scene);
        boneMat.diffuseColor = boneColor;
        boneMat.specularColor = new Color3(0, 0, 0);
        boneMat.emissiveColor = boneColor.scale(0.3);
        boneMat.backFaceCulling = false;
        boneMat.twoSidedLighting = true;
        boneMesh.material = boneMat;
        meshes.push(boneMesh);
    }

    const sphere = CreateSphere(`${name}-joints`, { diameter: 2, segments: 8 }, scene);
    sphere.isPickable = false;

    const matrices = new Float32Array(bones.length * 16);
    const tmp = Matrix.Identity();
    const scaleVec = new Vector3(radius, radius, radius);
    const posVec = new Vector3();
    for (let i = 0; i < bones.length; i++) {
        posVec.set(...bones[i].world_position);
        Matrix.ComposeToRef(scaleVec, _IDENTITY_QUAT, posVec, tmp);
        tmp.copyToArray(matrices, i * 16);
    }
    sphere.thinInstanceSetBuffer('matrix', matrices, 16);

    const jointColor = options?.jointColor ?? new Color3(0.55, 0.85, 1.0);
    const jointMat = new StandardMaterial(`${name}-joints-mat`, scene);
    jointMat.diffuseColor = jointColor;
    jointMat.specularColor = new Color3(0, 0, 0);
    jointMat.emissiveColor = jointColor.scale(0.4);
    jointMat.backFaceCulling = false;
    sphere.material = jointMat;
    meshes.push(sphere);

    return { meshes, jointRadius: radius, bbox };
}

export interface BuiltBabylonSkeleton {
    skeleton: Skeleton;
    bones: Bone[];
    joints: BoneData[];
    boneIndexByHash: Map<number, number>;
}

export function buildBabylonSkeleton(
    skl: SklData,
    scene: Scene,
    name: string = 'skeleton',
): BuiltBabylonSkeleton {
    const skeleton = new Skeleton(name, `${name}-${Date.now()}`, scene);

    const bones: Array<Bone | null> = new Array(skl.bones.length).fill(null);
    const boneIndexByHash = new Map<number, number>();

    const ensure = (i: number, depth: number): Bone | null => {
        if (bones[i]) return bones[i];
        if (depth > skl.bones.length) {
            console.warn(`[skeleton] cyclic parent chain at bone index ${i} — orphaning bone`);
            return null;
        }
        const bData = skl.bones[i];
        const parentIdx = skl.bones.findIndex(b => b.id === bData.parent_id);
        const parent = parentIdx >= 0 ? ensure(parentIdx, depth + 1) : null;

        const localMatrix = composeTrsMatrix(
            bData.local_translation,
            bData.local_rotation,
            bData.local_scale,
        );

        const bone = new Bone(
            bData.name,
            skeleton,
            parent,
            localMatrix,
            undefined,
            undefined,
            i,
        );
        bones[i] = bone;
        boneIndexByHash.set(elfHash(bData.name), i);
        return bone;
    };

    for (let i = 0; i < skl.bones.length; i++) {
        ensure(i, 0);
    }

    return {
        skeleton,
        bones: bones as Bone[],
        joints: skl.bones,
        boneIndexByHash,
    };
}

export function composeTrsMatrix(
    translation: [number, number, number],
    rotationXyzw: [number, number, number, number],
    scale: [number, number, number],
): Matrix {
    return Matrix.Compose(
        new Vector3(scale[0], scale[1], scale[2]),
        new Quaternion(rotationXyzw[0], rotationXyzw[1], rotationXyzw[2], rotationXyzw[3]),
        new Vector3(translation[0], translation[1], translation[2]),
    );
}
