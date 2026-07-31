import { invokeCommand } from './core';

interface MaterialRange {
    name: string;
    start_index: number;
    index_count: number;
    start_vertex: number;
    vertex_count: number;
}

type MaterialDataInfo = {
    texture: string;
    uv_scale?: [number, number];
    uv_offset?: [number, number];
    flipbook_size?: [number, number];
    flipbook_frame?: number;
};

/**
 * Mesh data uses typed arrays for vertex buffers — these come straight off
 * the IPC `ArrayBuffer` and are handed directly to `THREE.BufferAttribute`,
 * so the renderer skips the per-vertex JSON round-trip entirely.
 */
export interface SknMeshData {
    kind: 'skn';
    materials: MaterialRange[];
    bounding_box: [[number, number, number], [number, number, number]];
    textures?: Record<string, string>;
    material_data?: Record<string, MaterialDataInfo>;
    texture_warning?: string;
    vertex_count: number;
    index_count: number;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint16Array;
    bone_weights?: Float32Array;
    bone_indices?: Uint8Array;
}

export interface ScbMeshData {
    kind: 'scb';
    name: string;
    materials: string[];
    bounding_box: [[number, number, number], [number, number, number]];
    material_ranges: Record<string, [number, number]>;
    material_data?: Record<string, MaterialDataInfo>;
    texture_warning?: string;
    vertex_count: number;
    index_count: number;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

/**
 * Wire format for `read_skn_mesh` / `read_scb_mesh`. The big vertex/index
 * buffers travel as raw bytes; the small structural metadata sits in a
 * length-prefixed JSON header up front.
 *
 * Shape:
 * ```text
 * [u32 meta_len] [meta_json utf-8] [pad to 4-byte boundary]
 * [vertex_count × 3 × f32] positions
 * [vertex_count × 3 × f32] normals
 * [vertex_count × 2 × f32] uvs
 * [index_count × idx_bytes] indices  (idx_bytes = 2 for SKN, 4 for SCB)
 * (SKN only when has_bones)
 *   [vertex_count × 4 × f32] bone_weights
 *   [vertex_count × 4 × u8]  bone_indices
 * ```
 */
function decodeMeshPayload(buf: ArrayBuffer): SknMeshData | ScbMeshData {
    const view = new DataView(buf);
    const metaLen = view.getUint32(0, true);
    const metaBytes = new Uint8Array(buf, 4, metaLen);
    const meta = JSON.parse(new TextDecoder('utf-8').decode(metaBytes));

    let off = 4 + metaLen;
    if (off % 4 !== 0) off += 4 - (off % 4);

    const vertexCount: number = meta.vertex_count;
    const indexCount: number = meta.index_count;
    const indexBits: number = meta.index_bits;

    const posLen = vertexCount * 3;
    const positions = new Float32Array(buf.slice(off, off + posLen * 4));
    off += posLen * 4;

    const normals = new Float32Array(buf.slice(off, off + posLen * 4));
    off += posLen * 4;

    const uvLen = vertexCount * 2;
    const uvs = new Float32Array(buf.slice(off, off + uvLen * 4));
    off += uvLen * 4;

    let indices: Uint16Array | Uint32Array;
    if (indexBits === 16) {
        indices = new Uint16Array(buf.slice(off, off + indexCount * 2));
        off += indexCount * 2;
    } else {
        indices = new Uint32Array(buf.slice(off, off + indexCount * 4));
        off += indexCount * 4;
    }

    if (meta.kind === 'skn') {
        const skn: SknMeshData = {
            kind: 'skn',
            materials: meta.materials,
            bounding_box: meta.bounding_box,
            textures: meta.textures,
            material_data: meta.material_data,
            texture_warning: meta.texture_warning,
            vertex_count: vertexCount,
            index_count: indexCount,
            positions,
            normals,
            uvs,
            indices: indices as Uint16Array,
        };
        if (meta.has_bones) {
            const bwLen = vertexCount * 4;
            skn.bone_weights = new Float32Array(buf.slice(off, off + bwLen * 4));
            off += bwLen * 4;
            skn.bone_indices = new Uint8Array(buf.slice(off, off + bwLen));
        }
        return skn;
    }

    const scb: ScbMeshData = {
        kind: 'scb',
        name: meta.name,
        materials: meta.materials,
        bounding_box: meta.bounding_box,
        material_ranges: meta.material_ranges,
        material_data: meta.material_data,
        texture_warning: meta.texture_warning,
        vertex_count: vertexCount,
        index_count: indexCount,
        positions,
        normals,
        uvs,
        indices: indices as Uint32Array,
    };
    return scb;
}

export async function readSknMesh(path: string): Promise<SknMeshData> {
    const buf = await invokeCommand<ArrayBuffer>('read_skn_mesh', { path });
    const mesh = decodeMeshPayload(buf);
    if (mesh.kind !== 'skn') throw new Error('Expected SKN payload, got SCB');
    return mesh;
}

export async function readScbMesh(path: string): Promise<ScbMeshData> {
    const buf = await invokeCommand<ArrayBuffer>('read_scb_mesh', { path });
    const mesh = decodeMeshPayload(buf);
    if (mesh.kind !== 'scb') throw new Error('Expected SCB payload, got SKN');
    return mesh;
}

// =============================================================================
// Skeleton + Animation
// =============================================================================

interface BoneData {
    name: string;
    id: number;
    parent_id: number;
    local_translation: [number, number, number];
    local_rotation: [number, number, number, number];
    local_scale: [number, number, number];
    world_position: [number, number, number];
    inverse_bind_matrix: [[number, number, number, number], [number, number, number, number], [number, number, number, number], [number, number, number, number]];
}

interface SklData {
    name: string;
    asset_name: string;
    bones: BoneData[];
    influences: number[];
}

export async function readSklSkeleton(path: string): Promise<SklData> {
    return invokeCommand('read_skl_skeleton', { path });
}

/** One submesh-visibility event within an animation clip. `hide_hashes` / `show_hashes` are
 *  FNV1a-32 (lowercased) submesh-name hashes; `start_frame` is a frame index. */
export interface SubmeshVisEvent {
    start_frame: number;
    hide_hashes: number[];
    show_hashes: number[];
}

export interface AnimationClipInfo {
    name: string;
    track_name: string | null;
    animation_path: string;
    /** Submesh-visibility events for this clip, sorted by `start_frame` (may be empty). */
    events?: SubmeshVisEvent[];
}

export interface AnimationList {
    clips: AnimationClipInfo[];
    /** Submesh names hidden at load (from the skin BIN's `initialSubmeshToHide`). */
    initial_hide?: string[];
    /** Submesh names excluded from the shadow pass at load (`initialSubmeshShadowsToHide`). */
    initial_shadow_hide?: string[];
}

interface AnimationData {
    duration: number;
    fps: number;
    joint_count: number;
    joint_hashes: number[];
}

interface JointTransform {
    rotation: [number, number, number, number];
    translation: [number, number, number];
    scale: [number, number, number];
}

export interface AnimationPose {
    time: number;
    joints: Record<number, JointTransform>;
}

export async function readAnimationList(sknPath: string): Promise<AnimationList> {
    return invokeCommand('read_animation_list', { sknPath });
}

export async function readAnimation(path: string, basePath?: string): Promise<AnimationData> {
    return invokeCommand('read_animation', { path, basePath });
}

export async function resolveAssetPath(assetPath: string, binPath: string): Promise<string> {
    return invokeCommand('resolve_asset_path', { assetPath, binPath });
}

export interface AnmSkinResolution {
    skn_path: string;
    anm_asset_path: string;
}

export async function resolveAnmSkin(anmPath: string): Promise<AnmSkinResolution> {
    return invokeCommand('resolve_anm_skin', { anmPath });
}

/** Submesh (material-range) names of a `.skn`, for the BIN editor's Submesh picker. */
export async function readSknSubmeshNames(sknPath: string): Promise<string[]> {
    return invokeCommand('read_skn_submesh_names', { sknPath });
}
