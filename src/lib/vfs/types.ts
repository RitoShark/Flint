/**
 * A uniform view over "things that contain files": WAD archives, modpkg
 * packages, extracted folders, CDN-backed remote WADs.
 *
 * Every browser surface used to build its own tree from its own shape, which is
 * why search, sorting and context actions drifted between them. A mount answers
 * `list(dir)` for one level and declares what it can do, so a single tree
 * component renders all of them and enables actions from `caps` rather than
 * branching on which archive kind it happens to be looking at.
 *
 * This is presentation over formats — the formats themselves stay in ritoshark.
 * Nothing here mounts anything at the OS level; paths are internal to Flint.
 */

/** One entry in a mount. Directories are synthesised from chunk paths. */
export interface VfsEntry {
    /** Full '/'-separated path within the mount. No leading slash. */
    path: string;
    /** Last path segment. */
    name: string;
    isDirectory: boolean;
    /** Uncompressed size in bytes, when the mount knows it. */
    size?: number;
    /**
     * Backing identity: the chunk hash for archive mounts, the disk path for
     * folder mounts. Reads go through this rather than the display path, since
     * an archive's real key is its hash.
     */
    key: string;
}

/**
 * What a mount actually supports. Declared rather than inferred so the tree can
 * enable or hide actions without knowing the mount kind: a CDN WAD is read-only,
 * an edit session is fully writable, a plain on-disk WAD is read-only.
 */
export interface VfsCapabilities {
    write: boolean;
    rename: boolean;
    remove: boolean;
    add: boolean;
}

export const READ_ONLY: VfsCapabilities = {
    write: false,
    rename: false,
    remove: false,
    add: false,
};

export const FULLY_WRITABLE: VfsCapabilities = {
    write: true,
    rename: true,
    remove: true,
    add: true,
};

export interface Vfs {
    /** Stable id for this mount (session id, wad path, …). */
    readonly id: string;
    /** Human label for the surface showing it. */
    readonly label: string;
    readonly caps: VfsCapabilities;

    /**
     * Entries directly under `dir` — one level only, NOT recursive. Pass `''`
     * for the root. A whole-tree build over a 40k-chunk WAD on every keystroke
     * is what made the old browsers slow.
     */
    list(dir: string): Promise<VfsEntry[]>;

    /** Flat matches across the whole mount, for search mode. */
    search(query: string): Promise<VfsEntry[]>;

    /** Raw bytes of one file. */
    read(entry: VfsEntry): Promise<Uint8Array>;

    /** Present when `caps.write`. */
    write?(entry: VfsEntry, bytes: Uint8Array): Promise<void>;
    /** Present when `caps.rename`. `to` is a full path within the mount. */
    rename?(entry: VfsEntry, to: string): Promise<void>;
    /** Present when `caps.remove`. */
    remove?(entry: VfsEntry): Promise<void>;
    /** Present when `caps.add`. `path` is a full path within the mount. */
    add?(path: string, bytes: Uint8Array): Promise<void>;
}

/** A file inside a mount, before it is arranged into a tree. */
export interface VfsFileRecord {
    /** Display path; `null`/empty for chunks whose hash never resolved. */
    path: string | null;
    /** Chunk hash or other backing key. */
    key: string;
    size?: number;
}

/** Folder that collects chunks whose hash never resolved to a path. */
export const UNKNOWN_DIR = '[Unknown Hashes]';
