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

/**
 * A WAD mount re-indexes in place when its chunk set changes (a staged rename,
 * delete or a re-resolve after unhashing), so the session keeps ONE mount for
 * its lifetime instead of callers rebuilding one per edit.
 */
export interface WadMount extends Vfs {
    reindex(next: readonly ChunkLike[]): void;
    /**
     * Grant write access once an edit session exists for this WAD.
     *
     * The edit session opens moments AFTER the chunks arrive, so the mount is
     * created read-only and upgraded here. It mutates in place rather than
     * returning a new mount because consumers key cached directory listings on
     * mount identity — swapping the object would collapse the user's open
     * folders the instant the session finished opening.
     */
    attachEditSession(sessionId: string): void;
}

function makeMount(
    chunks: readonly ChunkLike[],
    backing: WadMountBacking,
    caps = READ_ONLY,
): WadMount {
    let index = new PathIndex(toRecords(chunks));
    // Held separately so `attachEditSession` can widen it without assigning to
    // the interface's readonly `caps` — callers still see an immutable view.
    let currentCaps = caps;

    const mount: WadMount = {
        id: backing.id,
        label: backing.label,
        get caps() { return currentCaps; },
        keyedBy: 'hash',
        async list(dir) {
            return index.list(normalizeDir(dir));
        },
        async search(query) {
            return index.filter(makeMatcher(query));
        },
        read: (entry) => backing.readBytes(entry),
        reindex(next) {
            index = new PathIndex(toRecords(next));
        },
        attachEditSession(sessionId) {
            // Replaced, never mutated: `caps` may be the shared READ_ONLY
            // constant, and mutating it would make every read-only mount in the
            // app writable.
            // No `add`: staging a NEW chunk needs the path hashed to
            // xxhash64(lowercased) first and no command exposes that, so
            // claiming the capability would make `caps` lie.
            currentCaps = { write: true, rename: true, remove: true, add: false };
            mount.write = (entry, bytes) => api.writeSessionChunk(sessionId, entry.key, bytes);
            mount.rename = async (entry, to) => { await api.renameSessionChunk(sessionId, entry.key, to); };
            mount.remove = (entry) => api.removeSessionChunk(sessionId, entry.key);
            // Reads move to the session so staged edits are visible, not the
            // bytes still sitting on disk.
            mount.read = (entry) => api.readSessionChunk(sessionId, entry.key);
        },
    };

    // Only expose the mutating methods a mount actually supports, so a caller
    // checking `mount.write` gets the truth rather than a method that throws.
    if (caps.write && backing.write) mount.write = backing.write;
    if (caps.rename && backing.rename) mount.rename = backing.rename;
    if (caps.remove && backing.remove) mount.remove = backing.remove;
    if (caps.add && backing.add) mount.add = backing.add;

    return mount;
}

/** A `.wad.client` on disk, read-only. */
export function mountWad(wadPath: string, chunks: readonly ChunkLike[]): WadMount {
    return makeMount(chunks, {
        id: `wad:${wadPath}`,
        label: wadPath.split(/[\\/]/).pop() ?? wadPath,
        readBytes: (entry) => api.readWadChunkData(wadPath, entry.key),
    });
}

/** A remote WAD read through a CDN manifest session. Range-fetched, read-only. */
export function mountCdnWad(
    sessionId: string,
    wadFileIndex: number,
    label: string,
    chunks: readonly ChunkLike[],
): WadMount {
    return makeMount(chunks, {
        id: `cdn:${sessionId}:${wadFileIndex}`,
        label,
        readBytes: async (entry) =>
            new Uint8Array(await api.cdnReadInner(sessionId, wadFileIndex, entry.key)),
    });
}
