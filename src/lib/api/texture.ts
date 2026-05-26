import { invokeCommand, invokeRaw } from './core';

interface DecodedTexture {
    data: string;
    width: number;
    height: number;
    format: string;
}

/**
 * Decode DDS or TEX texture file to PNG.
 * Despite the name, this handles both DDS and TEX formats.
 */
export async function decodeDdsToPng(path: string): Promise<DecodedTexture> {
    return invokeCommand('decode_dds_to_png', { path });
}

/**
 * Decode raw DDS/TEX bytes (already in memory) to a base64-encoded PNG.
 * Used by the WAD browser for in-memory preview — no disk file needed.
 */
export async function decodeBytesToPng(data: Uint8Array): Promise<DecodedTexture> {
    return invokeRaw('decode_bytes_to_png', data);
}

/** Get bundled floor texture as PNG bytes (MindCorpViewer floor.dds pre-converted). */
export async function getBundledFloorPng(): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('get_bundled_floor_png', {});
    return new Uint8Array(buf);
}

// =============================================================================
// Texture Format Conversion (TEX ↔ DDS, → PNG)
// =============================================================================

export interface TextureConversionResult {
    /** Absolute path of the file that was written. */
    output_path: string;
    width: number;
    height: number;
    /** Human-readable description of the chosen encode format (e.g. "BC3 (DXT5)"). */
    format: string;
}

/** Convert a .tex file to a sibling .dds. The source file is left intact. */
export async function convertTexToDds(path: string): Promise<TextureConversionResult> {
    return invokeCommand('convert_tex_to_dds', { path });
}

/** Convert a .dds file to a sibling .tex. The source file is left intact. */
export async function convertDdsToTex(path: string): Promise<TextureConversionResult> {
    return invokeCommand('convert_dds_to_tex', { path });
}

/** Decode a .tex or .dds and write a sibling .png. */
export async function convertTextureToPng(path: string): Promise<TextureConversionResult> {
    return invokeCommand('convert_texture_to_png', { path });
}

/** In-memory: TEX bytes → DDS bytes. Used when editing WAD chunks. */
export async function convertTexBytesToDds(data: Uint8Array): Promise<Uint8Array> {
    const buf = await invokeRaw<ArrayBuffer>('convert_tex_bytes_to_dds', data);
    return new Uint8Array(buf);
}

/** In-memory: DDS bytes → TEX bytes. Used when editing WAD chunks. */
export async function convertDdsBytesToTex(data: Uint8Array): Promise<Uint8Array> {
    const buf = await invokeRaw<ArrayBuffer>('convert_dds_bytes_to_tex', data);
    return new Uint8Array(buf);
}
