import { invokeCommand, invokeRaw } from './core';

export type ArtifactKindTag = 'game' | 'client' | 'other';

export interface ManifestEntryDto {
    artifact_type: string;
    kind: ArtifactKindTag;
    version: string;
    patch: string;
    url: string;
}

export interface CdnTreeNode {
    name: string;
    path: string;
    size: number;
    is_dir: boolean;
    file_index: number | null;
    children: CdnTreeNode[];
}

export interface CdnLoadResult {
    session_id: string;
    tree: CdnTreeNode;
    file_count: number;
}

export interface CdnWadChunk {
    hash: string;
    path: string | null;
    size: number;
}

export type CdnProgress =
    | { type: 'fileStart'; path: string; size: number }
    | { type: 'fileDone'; path: string; verified: boolean }
    | { type: 'note'; message: string }
    | { type: 'fileError'; path: string; error: string }
    | { type: 'allDone'; files: number; errors: number };

export interface CdnExtractSummary {
    files: number;
    errors: number;
}

export function cdnListManifests(region: string, platform: string): Promise<ManifestEntryDto[]> {
    return invokeCommand('cdn_list_manifests', { region, platform });
}

export function cdnLoadManifest(url: string): Promise<CdnLoadResult> {
    return invokeCommand('cdn_load_manifest', { url });
}

/** One catalogued manifest version from the GitHub history repo. */
export interface CatalogEntryDto {
    path: string;
    kind: ArtifactKindTag;
    patch: string;
    build: string;
    version: string;
}

/** Full manifest history for region+platform (all kinds), newest first. Disk-cached. */
export function cdnListVersions(region: string, platform: string, refresh = false): Promise<CatalogEntryDto[]> {
    return invokeCommand('cdn_list_versions', { region, platform, refresh });
}

/** Resolve a catalog repo path to its manifest URL (cached) and load it. */
export function cdnLoadManifestByPath(repoPath: string): Promise<CdnLoadResult> {
    return invokeCommand('cdn_load_manifest_by_path', { repoPath });
}

export function cdnListWad(sessionId: string, fileIndex: number): Promise<CdnWadChunk[]> {
    return invokeCommand('cdn_list_wad', { sessionId, fileIndex });
}

/** Raw inner-entry bytes via range fetch. Scalars travel in headers (raw-bytes IPC). */
export function cdnReadInner(sessionId: string, wadFileIndex: number, hash: string): Promise<ArrayBuffer> {
    return invokeRaw('cdn_read_inner', new Uint8Array(0), {
        'session-id': sessionId,
        'wad-file-index': String(wadFileIndex),
        'path-hash': hash,
    });
}

/**
 * Extract selected manifest file indices to `outDir`. Progress is emitted by the
 * backend as `cdn-extract-progress` events; subscribe via listenCdnExtractProgress.
 */
export function cdnExtract(sessionId: string, fileIndices: number[], outDir: string): Promise<CdnExtractSummary> {
    return invokeCommand('cdn_extract', { sessionId, fileIndices, outDir });
}

export function cdnCloseSession(sessionId: string): Promise<boolean> {
    return invokeCommand('cdn_close_session', { sessionId });
}
