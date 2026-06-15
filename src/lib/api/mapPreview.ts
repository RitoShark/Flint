import { invokeCommand } from './core';
import type { SubmeshRange } from '../babylon/meshBuilder';

export interface MapPreviewData {
    variant: string;
    submeshes: SubmeshRange[];
    /** submesh name -> diffuse texture path (bin path, e.g. "ASSETS/.../foo.tex") */
    materials: Record<string, string>;
    bounding_box: [[number, number, number], [number, number, number]];
    positions: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

export interface MapTexture {
    width: number;
    height: number;
    rgba: Uint8Array;
}

/**
 * Decode the binary payload from `load_map_preview`:
 * `[u32 meta_len][meta json utf-8][pad to 4][positions f32][uvs f32][indices u32]`.
 */
function decodeMapPayload(buf: ArrayBuffer): MapPreviewData {
    const view = new DataView(buf);
    const metaLen = view.getUint32(0, true);
    const metaBytes = new Uint8Array(buf, 4, metaLen);
    const meta = JSON.parse(new TextDecoder('utf-8').decode(metaBytes));

    let off = 4 + metaLen;
    if (off % 4 !== 0) off += 4 - (off % 4);

    const vertexCount: number = meta.vertex_count;
    const indexCount: number = meta.index_count;

    const positions = new Float32Array(buf.slice(off, off + vertexCount * 3 * 4));
    off += vertexCount * 3 * 4;
    const uvs = new Float32Array(buf.slice(off, off + vertexCount * 2 * 4));
    off += vertexCount * 2 * 4;
    const indices = new Uint32Array(buf.slice(off, off + indexCount * 4));

    return {
        variant: meta.variant,
        submeshes: meta.submeshes,
        materials: meta.materials,
        bounding_box: meta.bounding_box,
        positions,
        uvs,
        indices,
    };
}

export async function openMapPreviewWindow(projectPath: string): Promise<void> {
    return invokeCommand('open_map_preview_window', { projectPath });
}

export async function loadMapPreview(projectPath: string): Promise<MapPreviewData> {
    const buf = await invokeCommand<ArrayBuffer>('load_map_preview', { projectPath });
    return decodeMapPayload(buf);
}

export async function loadMapTexture(
    projectPath: string,
    texturePath: string,
): Promise<MapTexture> {
    const buf = await invokeCommand<ArrayBuffer>('load_map_texture', {
        projectPath,
        texturePath,
    });
    // Payload: [u32 width][u32 height][rgba...].
    const view = new DataView(buf);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const rgba = new Uint8Array(buf.slice(8));
    return { width, height, rgba };
}

export async function resolveMapTexturePath(
    projectPath: string,
    texturePath: string,
): Promise<string> {
    return invokeCommand('resolve_map_texture_path', { projectPath, texturePath });
}

export async function savePaintedTexture(
    projectPath: string,
    texturePath: string,
    rgba: Uint8Array,
    width: number,
    height: number,
): Promise<void> {
    return invokeCommand('save_painted_texture', {
        projectPath,
        texturePath,
        rgba: Array.from(rgba),
        width,
        height,
    });
}

export interface ApplyPsdReport {
    written: number;
    skipped: string[];
    errors: string[];
}

// ── Map texture sections (Ground + wall/prop categories) ─────────────────────
export type WallCategory = 'Walls' | 'Camps' | 'Pits' | 'River' | 'Misc';
export type CombineMode = 'Combined' | 'Split';

export interface MapTextureSection {
    name: string;        // "Ground" | "Walls" | "Camps" | "Pits" | "River" | "Misc"
    tile_count: number;
    exists: boolean;
    supports_mode: boolean; // only Ground (it has a grid) toggles Combined/Split
}

export async function listMapTextureSections(projectPath: string): Promise<MapTextureSection[]> {
    return invokeCommand('list_map_texture_sections', { projectPath });
}

export function sectionPsdPath(projectPath: string, section: string): string {
    const file = section === 'Ground' ? 'ground_map.psd' : `${section.toLowerCase()}.psd`;
    return `${projectPath}/textures-psd/${file}`;
}

/** Combine a section into its PSD. mode applies only to Ground. Returns path. */
export async function combineSection(
    projectPath: string,
    section: string,
    mode: CombineMode,
): Promise<string> {
    if (section === 'Ground') {
        return invokeCommand('combine_ground_to_psd', { projectPath, mode });
    }
    return invokeCommand('combine_category_to_psd', { projectPath, category: section, mode });
}

export async function applySection(projectPath: string, section: string): Promise<ApplyPsdReport> {
    if (section === 'Ground') {
        return invokeCommand('apply_psd_to_textures', {
            projectPath,
            psdPath: sectionPsdPath(projectPath, 'Ground'),
        });
    }
    return invokeCommand('apply_category_psd', { projectPath, category: section });
}

