import { invokeCommand, invokeRaw } from './core';

interface DecodedTexture {
    data: string;
    width: number;
    height: number;
    format: string;
}

/** Decode DDS or TEX texture file to PNG. Handles both DDS and TEX formats. */
export async function decodeDdsToPng(path: string): Promise<DecodedTexture> {
    return invokeCommand('decode_dds_to_png', { path });
}

export async function decodeBytesToPng(data: Uint8Array): Promise<DecodedTexture> {
    return invokeRaw('decode_bytes_to_png', data);
}

/** Decode DDS/TEX bytes to raw RGBA pixels (`[u32 w][u32 h][rgba…]` wire layout)
 *  for direct canvas rendering — no PNG or base64 anywhere in the path. */
export async function decodeBytesToRgba(
    data: Uint8Array,
): Promise<{ width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> }> {
    const buf = await invokeRaw<ArrayBuffer>('decode_bytes_to_rgba', data);
    const view = new DataView(buf);
    return {
        width: view.getUint32(0, true),
        height: view.getUint32(4, true),
        rgba: new Uint8ClampedArray(buf, 8),
    };
}

export async function getBundledFloorPng(): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('get_bundled_floor_png', {});
    return new Uint8Array(buf);
}

/** Raw WebP bytes of one bundled skybox cubemap face (px|nx|py|ny|pz|nz). */
export async function getBundledSkyboxFace(face: string): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('get_bundled_skybox_face', { face });
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

export async function convertTextureToPng(path: string): Promise<TextureConversionResult> {
    return invokeCommand('convert_texture_to_png', { path });
}

export interface AlignmentFixResult {
    path: string;
    old_width: number;
    old_height: number;
    width: number;
    height: number;
    format: string;
    /** The source shipped a mip chain the re-encode did not reproduce. */
    mipmaps_dropped: boolean;
}

/**
 * Resize a block-compressed texture up to the next multiple of 4 on both axes and
 * rewrite it in place, keeping its own container and format. Rejects a texture that
 * is already aligned.
 */
export async function fixTextureAlignment(path: string): Promise<AlignmentFixResult> {
    return invokeCommand('fix_texture_alignment', { path });
}

/** Encode format for a PNG going back into a texture. */
export type TextureEncodeFormat = 'bc1' | 'bc3' | 'rgba8';

/**
 * Convert a .png to a sibling .tex. The source file is left intact.
 *
 * Omit `format` to pick automatically: BC3 when the image has transparency,
 * BC1 (half the size) when it does not.
 */
export async function convertPngToTex(
    path: string,
    format?: TextureEncodeFormat,
): Promise<TextureConversionResult> {
    return invokeCommand('convert_png_to_tex', { path, format: format ?? null });
}

/** Convert a .png to a sibling .dds. Same format selection as `convertPngToTex`. */
export async function convertPngToDds(
    path: string,
    format?: TextureEncodeFormat,
): Promise<TextureConversionResult> {
    return invokeCommand('convert_png_to_dds', { path, format: format ?? null });
}

/** In-memory PNG → TEX, for bytes that never touch disk. */
export async function convertPngBytesToTex(
    data: Uint8Array,
    format?: TextureEncodeFormat,
): Promise<Uint8Array> {
    const buf = await invokeRaw<ArrayBuffer>(
        'convert_png_bytes_to_tex',
        data,
        format ? { 'tex-format': format } : undefined,
    );
    return new Uint8Array(buf);
}

export async function convertTexBytesToDds(data: Uint8Array): Promise<Uint8Array> {
    const buf = await invokeRaw<ArrayBuffer>('convert_tex_bytes_to_dds', data);
    return new Uint8Array(buf);
}

export async function convertDdsBytesToTex(data: Uint8Array): Promise<Uint8Array> {
    const buf = await invokeRaw<ArrayBuffer>('convert_dds_bytes_to_tex', data);
    return new Uint8Array(buf);
}
