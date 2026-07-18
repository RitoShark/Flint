import { invokeCommand } from './core';
import { FlintError } from './core';
import type { GameWadInfo } from '../types';

export async function readWad(wadPath: string): Promise<{ version: string; chunkCount: number }> {
    return invokeCommand('read_wad', { wadPath });
}

export async function getWadChunks(
    wadPath: string,
): Promise<Array<{ hash: string; path: string | null; size: number }>> {
    const batches = await loadAllWadChunks([wadPath]);
    const batch = batches[0];
    if (batch?.error) {
        throw new FlintError('get_wad_chunks', batch.error);
    }
    return batch?.chunks ?? [];
}

export interface WadChunkBatch {
    path: string;
    chunks: Array<{ hash: string; path: string | null; size: number }>;
    error: string | null;
}

/**
 * Wire layout (little-endian):
 *
 *   [u32 wad_count]
 *   per WAD:
 *     [u32 path_len] [path_bytes utf-8]
 *     [u32 error_len] [error_bytes utf-8]    // 0 when no error
 *     [u32 chunk_count]
 *     [chunk_count × u64 path_hash]
 *     [chunk_count × u32 size]
 *     [chunk_count × u16 resolved_path_len]  // 0xFFFF = null/unresolved
 *     [packed resolved-path utf-8 bytes ...]
 */
function decodeWadChunkPayload(bytes: Uint8Array): WadChunkBatch[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const utf8 = new TextDecoder('utf-8');
    let off = 0;

    const wadCount = view.getUint32(off, true); off += 4;
    const out: WadChunkBatch[] = new Array(wadCount);

    const HEX = new Array<string>(256);
    for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, '0');

    for (let w = 0; w < wadCount; w++) {
        const pathLen = view.getUint32(off, true); off += 4;
        const path = utf8.decode(bytes.subarray(off, off + pathLen)); off += pathLen;

        const errLen = view.getUint32(off, true); off += 4;
        if (errLen > 0) {
            const error = utf8.decode(bytes.subarray(off, off + errLen)); off += errLen;
            const chunkCount = view.getUint32(off, true); off += 4;
            off += chunkCount * (8 + 4 + 2);
            out[w] = { path, chunks: [], error };
            continue;
        }

        const chunkCount = view.getUint32(off, true); off += 4;
        const hashesOff = off;          off += chunkCount * 8;
        const sizesOff  = off;          off += chunkCount * 4;
        const lensOff   = off;          off += chunkCount * 2;
        let stringsOff = off;

        const chunks = new Array(chunkCount);
        for (let i = 0; i < chunkCount; i++) {
            const hbase = hashesOff + i * 8;
            const hash =
                HEX[bytes[hbase + 7]] +
                HEX[bytes[hbase + 6]] +
                HEX[bytes[hbase + 5]] +
                HEX[bytes[hbase + 4]] +
                HEX[bytes[hbase + 3]] +
                HEX[bytes[hbase + 2]] +
                HEX[bytes[hbase + 1]] +
                HEX[bytes[hbase + 0]];

            const size = view.getUint32(sizesOff + i * 4, true);
            const plen = view.getUint16(lensOff + i * 2, true);

            let path: string | null;
            if (plen === 0xFFFF) {
                path = null;
            } else {
                path = utf8.decode(bytes.subarray(stringsOff, stringsOff + plen));
                stringsOff += plen;
            }
            chunks[i] = { hash, path, size };
        }
        off = stringsOff;
        out[w] = { path, chunks, error: null };
    }
    return out;
}

export async function loadAllWadChunks(paths: string[]): Promise<WadChunkBatch[]> {
    const buf = await invokeCommand<ArrayBuffer>('load_all_wad_chunks', { paths });
    return decodeWadChunkPayload(new Uint8Array(buf));
}

export interface ExtractHashesResult {
    /** Files (BIN + SKN) actually scanned. */
    scanned: number;
    /** New (path → xxhash64) pairs added to hashes.extracted.txt */
    game_hashes_added: number;
    /** New (name → fnv1a32) pairs added to hashes.binhashes.extracted.txt */
    bin_hashes_added: number;
    /** Absolute paths of files written / merged. */
    output_files: string[];
}

export async function extractHashesFromWad(wadPath: string): Promise<ExtractHashesResult> {
    return invokeCommand('extract_hashes_from_wad', { wadPath });
}

export async function extractWad(
    wadPath: string,
    outputDir: string,
    chunkHashes: string[] | null = null
): Promise<{ extracted: number; failed: number }> {
    // The Rust command returns { extracted_count, failed_count } (serde
    // snake_case). Map to the clean shape callers expect — reading the wrong
    // field name previously gave `undefined`, which turned toast counts into NaN.
    const res = await invokeCommand<{ extracted_count: number; failed_count: number }>(
        'extract_wad', { wadPath, outputDir, chunkHashes },
    );
    return { extracted: res.extracted_count ?? 0, failed: res.failed_count ?? 0 };
}

/** Read a single WAD chunk into memory as decompressed raw bytes. */
export async function readWadChunkData(wadPath: string, hash: string): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('read_wad_chunk_data', { wadPath, hash });
    return new Uint8Array(buf);
}

export async function scanGameWads(gamePath: string): Promise<GameWadInfo[]> {
    return invokeCommand('scan_game_wads', { gamePath });
}

export async function invalidateWadCache(wadPath: string): Promise<void> {
    return invokeCommand('invalidate_wad_cache', { path: wadPath });
}

export async function readWadLuabin(wadPath: string, hash: string): Promise<string> {
    return invokeCommand('read_wad_luabin', { wadPath, hash });
}

export async function readWadTroybin(wadPath: string, hash: string): Promise<string> {
    return invokeCommand('read_wad_troybin', { wadPath, hash });
}

export async function readWadInibin(wadPath: string, hash: string): Promise<string> {
    return invokeCommand('read_wad_inibin', { wadPath, hash });
}

export async function readWadRst(wadPath: string, hash: string): Promise<string> {
    return invokeCommand('read_wad_rst', { wadPath, hash });
}

export async function convertLuabinToText(data: Uint8Array): Promise<string> {
    return invokeCommand('convert_luabin_to_text', { data: Array.from(data) });
}

export async function convertTroybinToText(data: Uint8Array): Promise<string> {
    return invokeCommand('convert_troybin_to_text', { data: Array.from(data) });
}

export async function extractWadModelPreview(
    wadPath: string,
    sknHash: string
): Promise<{ skn_path: string; temp_dir: string }> {
    return invokeCommand('extract_wad_model_preview', { wadPath, sknHash });
}

export async function cleanupWadModelPreview(tempDir: string): Promise<void> {
    return invokeCommand('cleanup_wad_model_preview', { tempDir });
}
