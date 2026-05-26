/**
 * Shared helpers and constants used across NewProjectModal's wizard steps.
 */

/**
 * Deflate compression using the browser's native CompressionStream.
 *
 * IMPORTANT: use 'deflate-raw' (RFC 1951, no header/trailer), NOT 'deflate'
 * (which outputs zlib format / RFC 1950 with a 2-byte header + Adler-32).
 * Rust's flate2::read::DeflateDecoder expects raw deflate.
 */
export async function compressDeflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Response(data as any).body!
        .pipeThrough(new CompressionStream('deflate-raw'));
    const compressedBuffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(compressedBuffer);
}

export type ProjectType = 'skin' | 'loading-screen' | 'map' | 'tft';

export const SCALE_OPTIONS = [
    { label: '100%', value: 1.0 },
    { label: '75%',  value: 0.75 },
    { label: '50%',  value: 0.5 },
    { label: '25%',  value: 0.25 },
];

export const FPS_OPTIONS = [15, 24, 30, 60];
