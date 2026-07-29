/**
 * VFS mount backed by an open ModPkg edit session.
 *
 * Unlike a WAD, a modpkg addresses chunks by path rather than by hash, so the
 * entry key IS the path. Everything else matches the WAD session mount: edits
 * are staged in the session and only reach disk on save.
 */

import * as api from '../api';
import { compileSearch } from '../../components/browser/wad-explorer/helpers';
import { PathIndex, normalizeDir } from './pathIndex';
import { type Vfs, type VfsEntry } from './types';

function makeMatcher(query: string): (entry: VfsEntry) => boolean {
    const trimmed = query.trim();
    if (!trimmed) return () => true;
    const re = compileSearch(trimmed);
    if (re) return (entry) => re.test(entry.path);
    const plain = trimmed.toLowerCase();
    return (entry) => entry.path.toLowerCase().includes(plain);
}

export interface ModpkgMount extends Vfs {
    /** Re-read the chunk list after an edit, so sizes and additions show up. */
    refresh(): Promise<void>;
    /** Paths with unsaved edits staged against them. */
    dirtyPaths(): Promise<string[]>;
}

/**
 * Mount an open modpkg session.
 *
 * `multiLayer` packages are mounted read-only: Flint's rebuild writes every
 * chunk to the base layer, so permitting edits would quietly flatten them.
 */
export async function mountModpkg(
    sessionId: string,
    label: string,
): Promise<ModpkgMount> {
    let index = new PathIndex([]);
    // Chunk path → its layer. A layered package can hold the same path on more
    // than one layer; the first listed wins for display, and edits carry the
    // layer through so a write never migrates a chunk off its own layer.
    let layerOf = new Map<string, string>();

    const reload = async () => {
        const chunks = await api.listModpkgChunks(sessionId);
        layerOf = new Map();
        for (const c of chunks) {
            if (!layerOf.has(c.path)) layerOf.set(c.path, c.layer);
        }
        index = new PathIndex(
            chunks.map((c) => ({ path: c.path, key: c.path, size: c.size })),
        );
    };
    await reload();

    const layerFor = (path: string) => layerOf.get(path);

    const mount: ModpkgMount = {
        id: `modpkg:${sessionId}`,
        label,
        // Layers survive the rebuild, so a layered package is as editable as a
        // plain one.
        caps: { write: true, rename: true, remove: true, add: true },
        keyedBy: 'path',
        async list(dir) {
            return index.list(normalizeDir(dir));
        },
        async search(query) {
            return index.filter(makeMatcher(query));
        },
        // The chunk path is the key, so reads go straight through it.
        read: (entry) => api.readModpkgChunk(sessionId, entry.key, layerFor(entry.key)),
        refresh: reload,
        dirtyPaths: () => api.modpkgDirtyChunks(sessionId),

        write: async (entry, bytes) => {
            await api.writeModpkgChunk(sessionId, entry.key, bytes, layerFor(entry.key));
            await reload();
        },
        rename: async (entry, to) => {
            await api.renameModpkgChunk(sessionId, entry.key, to, layerFor(entry.key));
            await reload();
        },
        remove: async (entry) => {
            await api.removeModpkgChunk(sessionId, entry.key, layerFor(entry.key));
            await reload();
        },
        // A write against an unknown path adds it — no separate command needed.
        add: async (path, bytes) => {
            await api.writeModpkgChunk(sessionId, path, bytes);
            await reload();
        },
    };

    return mount;
}
