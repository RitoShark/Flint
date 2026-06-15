import * as api from '../../../lib/api';

/** Abstracts "where do the inner-file bytes come from" for the preview/extract UI. */
export interface WadDataSource {
    /** Raw inner-file bytes for a given chunk hash (always a Uint8Array). */
    readInnerBytes(hash: string): Promise<Uint8Array>;
    /** True for the live local install (enables on-disk-only features like model preview). */
    readonly isLocal: boolean;
}

/** Local install: reads from a WAD file on disk via the existing command. */
export function localWadSource(wadPath: string): WadDataSource {
    return {
        isLocal: true,
        readInnerBytes: (hash) => api.readWadChunkData(wadPath, hash),
    };
}

/** CDN manifest: reads via range-fetch through the session (returns ArrayBuffer → Uint8Array). */
export function cdnWadSource(sessionId: string, wadFileIndex: number): WadDataSource {
    return {
        isLocal: false,
        readInnerBytes: async (hash) => new Uint8Array(await api.cdnReadInner(sessionId, wadFileIndex, hash)),
    };
}
