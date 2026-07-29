/**
 * VFS mounts backed by WAD archives.
 *
 * Three flavours share one implementation because they differ only in where the
 * bytes come from and what they permit:
 *   - a WAD file on disk (read-only)
 *   - an open edit session (read/write/rename/remove/add)
 *   - a CDN-backed remote WAD (read-only)
 */

import * as api from '../api';
import { compileSearch } from '../../components/browser/wad-explorer/helpers';
import { PathIndex, normalizeDir } from './pathIndex';
import { READ_ONLY, type Vfs, type VfsEntry, type VfsFileRecord } from './types';

/** Chunk shape both the WAD list commands and the CDN session return. */
export interface ChunkLike {
    hash: string;
    path: string | null;
    size?: number;
}

function toRecords(chunks: readonly ChunkLike[]): VfsFileRecord[] {
    return chunks.map((c) => ({ path: c.path, key: c.hash, size: c.size }));
}

/**
 * Search matching identical to the WAD explorer's: a query with no regex
 * metacharacter is a plain substring test (so a bare `.` stays literal and
 * "body.tex" is an extension search), anything else compiles as a regex and
 * falls back to substring when it does not compile.
 */
function makeMatcher(query: string): (entry: VfsEntry) => boolean {
    const trimmed = query.trim();
    if (!trimmed) return () => true;
    const re = compileSearch(trimmed);
    if (re) return (entry) => re.test(entry.path);
    const plain = trimmed.toLowerCase();
    return (entry) => entry.path.toLowerCase().includes(plain);
}

interface WadMountBacking {
    id: string;
    label: string;
    readBytes(entry: VfsEntry): Promise<Uint8Array>;
    write?(entry: VfsEntry, bytes: Uint8Array): Promise<void>;
    rename?(entry: VfsEntry, to: string): Promise<void>;
    remove?(entry: VfsEntry): Promise<void>;
    add?(path: string, bytes: Uint8Array): Promise<void>;
}

function makeMount(
    chunks: readonly ChunkLike[],
    backing: WadMountBacking,
    caps = READ_ONLY,
): Vfs {
    let index = new PathIndex(toRecords(chunks));

    const mount: Vfs = {
        id: backing.id,
        label: backing.label,
        caps,
        keyedBy: 'hash',
        async list(dir) {
            return index.list(normalizeDir(dir));
        },
        async search(query) {
            return index.filter(makeMatcher(query));
        },
        read: (entry) => backing.readBytes(entry),
    };

    // Only expose the mutating methods a mount actually supports, so a caller
    // checking `mount.write` gets the truth rather than a method that throws.
    if (caps.write && backing.write) mount.write = backing.write;
    if (caps.rename && backing.rename) mount.rename = backing.rename;
    if (caps.remove && backing.remove) mount.remove = backing.remove;
    if (caps.add && backing.add) mount.add = backing.add;

    /** Re-index after a mutation changes the chunk set. */
    (mount as Vfs & { reindex(next: readonly ChunkLike[]): void }).reindex = (next) => {
        index = new PathIndex(toRecords(next));
    };

    return mount;
}

/** A `.wad.client` on disk, read-only. */
export function mountWad(wadPath: string, chunks: readonly ChunkLike[]): Vfs {
    return makeMount(chunks, {
        id: `wad:${wadPath}`,
        label: wadPath.split(/[\\/]/).pop() ?? wadPath,
        readBytes: (entry) => api.readWadChunkData(wadPath, entry.key),
    });
}

/**
 * An open WAD edit session. Writes are staged in the session and only reach disk
 * on save, which is why every mutation here is a session command rather than a
 * file write.
 */
export function mountWadSession(sessionId: string, label: string, chunks: readonly ChunkLike[]): Vfs {
    return makeMount(
        chunks,
        {
            id: `wad-session:${sessionId}`,
            label,
            readBytes: (entry) => api.readSessionChunk(sessionId, entry.key),
            write: (entry, bytes) => api.writeSessionChunk(sessionId, entry.key, bytes),
            // A rename re-keys the chunk under xxhash64 of the lowercased path,
            // so it is a real re-key in the session, not a label change.
            rename: async (entry, to) => { await api.renameSessionChunk(sessionId, entry.key, to); },
            remove: (entry) => api.removeSessionChunk(sessionId, entry.key),
        },
        // No `add`: staging a brand-new chunk needs the path hashed to
        // xxhash64(lowercased path) first, and there is no command for that yet.
        // Declaring the capability without backing it would make `caps` lie.
        { write: true, rename: true, remove: true, add: false },
    );
}

/** A remote WAD read through a CDN manifest session. Range-fetched, read-only. */
export function mountCdnWad(
    sessionId: string,
    wadFileIndex: number,
    label: string,
    chunks: readonly ChunkLike[],
): Vfs {
    return makeMount(chunks, {
        id: `cdn:${sessionId}:${wadFileIndex}`,
        label,
        readBytes: async (entry) =>
            new Uint8Array(await api.cdnReadInner(sessionId, wadFileIndex, entry.key)),
    });
}
