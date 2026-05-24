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

export interface BuiltOctaSkeleton {
    mesh: Mesh;
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

export function buildSkeletonOctahedrons(
    skl: SklData,
    scene: Scene,
    options?: { color?: Color3; name?: string },
): BuiltOctaSkeleton | null {
    const bones = skl.bones;
    if (bones.length === 0) return null;

    const positions: number[] = [];
    const indices: number[] = [];

    const TRIS: ReadonlyArray<readonly [number, number, number]> = [
        [0, 2, 1],
        [0, 3, 2],
        [0, 4, 3],
        [0, 1, 4],
        [5, 1, 2],
        [5, 2, 3],
        [5, 3, 4],
        [5, 4, 1],
    ];

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const head = new Vector3();
    const tail = new Vector3();
    const dir = new Vector3();
    const right = new Vector3();
    const up = new Vector3();
    const upRef = new Vector3();
    const upRefAlt = new Vector3();

    for (const bone of bones) {
        if (bone.parent_id < 0) continue;
        const parent = bones.find(b => b.id === bone.parent_id);
        if (!parent) continue;

        head.set(...parent.world_position);
        tail.set(...bone.world_position);
        dir.copyFrom(tail).subtractInPlace(head);
        const length = dir.length();
        if (length < 1e-6) continue;
        dir.scaleInPlace(1 / length);

        upRef.set(0, 1, 0);
        upRefAlt.set(1, 0, 0);
        const useAlt = Math.abs(Vector3.Dot(dir, upRef)) > 0.9;
        const ref = useAlt ? upRefAlt : upRef;
        Vector3.CrossToRef(ref, dir, right);
        right.normalize();
        Vector3.CrossToRef(dir, right, up);
        up.normalize();

        const ringY = length * 0.1;
        const r = length * 0.1;

        const baseIndex = positions.length / 3;
        const pushVert = (lx: number, ly: number, lz: number) => {
            const x = head.x + lx * right.x + ly * dir.x + lz * up.x;
            const y = head.y + lx * right.y + ly * dir.y + lz * up.y;
            const z = head.z + lx * right.z + ly * dir.z + lz * up.z;
            positions.push(x, y, z);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        };

        pushVert(0, 0, 0);            // v0 — head apex
        pushVert(r, ringY, 0);        // v1 — +right ring
        pushVert(0, ringY, r);        // v2 — +up ring
        pushVert(-r, ringY, 0);       // v3 — -right ring
        pushVert(0, ringY, -r);       // v4 — -up ring
        pushVert(0, length, 0);       // v5 — tail apex

        for (const [a, b, c] of TRIS) {
            indices.push(baseIndex + a, baseIndex + b, baseIndex + c);
        }
    }

    if (positions.length === 0) return null;

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;

    const mesh = new Mesh(options?.name ?? 'skeleton-octa', scene);
    vd.applyToMesh(mesh);
    mesh.isPickable = false;

    const baseColor = options?.color ?? new Color3(0.85, 0.85, 0.9);
    const mat = new StandardMaterial(`${options?.name ?? 'skeleton-octa'}-mat`, scene);
    mat.diffuseColor = baseColor;
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = baseColor.scale(0.25);
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    mesh.material = mat;

    const finite = (n: number) => (Number.isFinite(n) ? n : 0);
    return {
        mesh,
        bbox: {
            min: [finite(minX), finite(minY), finite(minZ)],
            max: [finite(maxX), finite(maxY), finite(maxZ)],
        },
    };
}

export interface BuiltJointMarkers {
    mesh: Mesh;
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

export function buildSkeletonJoints(
    skl: SklData,
    scene: Scene,
    options?: { color?: Color3; name?: string; radius?: number },
): BuiltJointMarkers | null {
    const bones = skl.bones;
    if (bones.length === 0) return null;

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
    const bboxMin: [number, number, number] = [finite(minX), finite(minY), finite(minZ)];
    const bboxMax: [number, number, number] = [finite(maxX), finite(maxY), finite(maxZ)];

    const dx = bboxMax[0] - bboxMin[0];
    const dy = bboxMax[1] - bboxMin[1];
    const dz = bboxMax[2] - bboxMin[2];
    const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const radius = options?.radius ?? Math.max(0.04, diagonal * 0.0048);

    const sphere = CreateSphere(
        options?.name ?? 'skeleton-joints',
        { diameter: 2, segments: 8 },
        scene,
    );
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

    const baseColor = options?.color ?? new Color3(0.55, 0.85, 1.0);
    const mat = new StandardMaterial(`${options?.name ?? 'skeleton-joints'}-mat`, scene);
    mat.diffuseColor = baseColor;
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = baseColor.scale(0.4);
    mat.backFaceCulling = false;
    sphere.material = mat;

    return {
        mesh: sphere,
        bbox: { min: bboxMin, max: bboxMax },
    };
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
