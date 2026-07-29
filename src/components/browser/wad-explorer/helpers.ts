import { getIcon } from '../../../lib/ui-helpers/fileIcons';
import { PathIndex } from '../../../lib/vfs/pathIndex';
import { UNKNOWN_DIR } from '../../../lib/vfs/types';
import type { WadChunk, WadExplorerWad } from '../../../lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// SVG icons
// ─────────────────────────────────────────────────────────────────────────────

export const ICON_GRID = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>`;

const CHECKBOX_UNCHECKED = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.2" opacity="0.5"/></svg>`;
const CHECKBOX_CHECKED = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="var(--accent, #4fc3f7)" stroke="var(--accent, #4fc3f7)" stroke-width="1.2"/><path d="M4.5 8l2.5 2.5 4.5-5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECKBOX_INDETERMINATE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="var(--accent, #4fc3f7)" stroke="var(--accent, #4fc3f7)" stroke-width="1.2" opacity="0.6"/><line x1="4.5" y1="8" x2="11.5" y2="8" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`;

export function checkboxSvg(state: 'none' | 'some' | 'all'): string {
    if (state === 'all') return CHECKBOX_CHECKED;
    if (state === 'some') return CHECKBOX_INDETERMINATE;
    return CHECKBOX_UNCHECKED;
}

// ─────────────────────────────────────────────────────────────────────────────
// VFS Tree types
// ─────────────────────────────────────────────────────────────────────────────

export interface VFSFolder {
    type: 'folder';
    name: string;
    /** Unique key: `${wadPath}::${folderPath}` */
    key: string;
    children: VFSNode[];
}

export interface VFSFile {
    type: 'file';
    name: string;
    chunk: WadChunk;
    wadPath: string;
}

export type VFSNode = VFSFolder | VFSFile;

// ─────────────────────────────────────────────────────────────────────────────
// VFS tree builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build one WAD's subtree.
 *
 * Arrangement (folders before files, each alphabetical, pathless chunks under a
 * synthetic folder) comes from the shared `PathIndex`, so this agrees with the
 * WAD browser instead of ordering things its own way.
 *
 * Unlike the browser, this materialises the WHOLE subtree rather than listing a
 * directory at a time: the explorer feeds a virtualised list that needs every
 * row up front to size and window the viewport across tens of thousands of
 * chunks.
 */
export function buildVFSSubtree(chunks: WadChunk[], wadPath: string): VFSNode[] {
    const index = new PathIndex(
        chunks.map(c => ({ path: c.path, key: c.hash, size: c.size })),
    );
    // Chunks addressed the way a WAD addresses them — by hash.
    const byHash = new Map<string, WadChunk>();
    for (const c of chunks) {
        if (!byHash.has(c.hash)) byHash.set(c.hash, c);
    }

    const toNodes = (dir: string): VFSNode[] => {
        const out: VFSNode[] = [];
        for (const entry of index.list(dir)) {
            if (entry.isDirectory) {
                const unknownCount = entry.path === UNKNOWN_DIR
                    ? index.list(entry.path).length
                    : 0;
                out.push({
                    type: 'folder',
                    // The explorer keys rows per WAD, since one tree holds many.
                    key: `${wadPath}::${entry.path === UNKNOWN_DIR ? '__unknown__' : entry.path}`,
                    name: unknownCount > 0 ? `${UNKNOWN_DIR} (${unknownCount})` : entry.name,
                    children: toNodes(entry.path),
                });
                continue;
            }
            // A miss means two chunks collapsed onto one hash; skip rather than
            // emit a row with no chunk behind it.
            const chunk = byHash.get(entry.key);
            if (chunk) out.push({ type: 'file', name: entry.name, chunk, wadPath });
        }
        return out;
    };

    return toNodes('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Search helpers
// ─────────────────────────────────────────────────────────────────────────────

// Regex metacharacters that signal the user actually WANTS regex matching.
// A bare `.` is deliberately NOT in this set: queries like ".string" or
// "2x_body.tex" are extension/filename searches where the dot must match
// literally — compiling them as regex made `.` match any character and
// surfaced unrelated results.
const REGEX_META = /[\\^$*+?()[\]{}|]/;

/** Quartz-style smart search, one input, no mode toggles: a query containing
 *  real regex metacharacters is compiled as a case-insensitive regex; plain
 *  text (dots included) matches as a literal lowercase substring. Returns
 *  null when substring matching should be used. */
export function compileSearch(query: string): RegExp | null {
    const trimmed = query.trim();
    if (!trimmed || !REGEX_META.test(trimmed)) return null;
    try {
        return new RegExp(trimmed, 'i');
    } catch {
        return null; // invalid regex → substring fallback
    }
}

export function matchChunk(chunk: WadChunk, re: RegExp | null, plain: string): boolean {
    if (re) return re.test(chunk.path ?? chunk.hash);
    // Lowercased path is cached on the chunk on first search to avoid
    // re-lowercasing the same string across keystrokes.
    let haystack = chunk.haystack;
    if (haystack === undefined) {
        haystack = chunk.path !== null ? chunk.path.toLowerCase() : chunk.hash;
        chunk.haystack = haystack;
    }
    return haystack.includes(plain);
}

export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0B';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** The client's default locale — the one locale WAD kept when hiding languages. */
export const DEFAULT_LOCALE = 'en_US';

/**
 * The locale segment of a WAD filename (`Aatrox.ko_KR.wad.client` → `ko_KR`),
 * or null if the WAD has no locale segment (the shared/default WAD).
 */
export function wadLocale(nameOrPath: string): string | null {
    const base = nameOrPath.split(/[\\/]/).pop() ?? nameOrPath;
    const m = base.match(/\.([a-z]{2}_[A-Z]{2})\.wad(?:\.client)?$/);
    return m ? m[1] : null;
}

/**
 * True when a WAD should be HIDDEN under the "hide other languages" filter:
 * it has a locale segment that isn't the default locale. No-locale (shared) and
 * default-locale WADs are always kept.
 */
export function isNonDefaultLocaleWad(nameOrPath: string, defaultLocale = DEFAULT_LOCALE): boolean {
    const loc = wadLocale(nameOrPath);
    return loc !== null && loc !== defaultLocale;
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkbox state helpers
// ─────────────────────────────────────────────────────────────────────────────

export function makeFileKey(wadPath: string, hash: string): string {
    return `${wadPath}::${hash}`;
}

export function collectFolderFileKeys(node: VFSFolder, wadPath: string): string[] {
    const keys: string[] = [];
    const walk = (n: VFSNode) => {
        if (n.type === 'file') keys.push(makeFileKey(wadPath, n.chunk.hash));
        else for (const c of n.children) walk(c);
    };
    walk(node);
    return keys;
}

export function collectFolderHashes(node: VFSFolder): string[] {
    const hashes: string[] = [];
    const walk = (n: VFSNode) => {
        if (n.type === 'file') hashes.push(n.chunk.hash);
        else for (const c of n.children) walk(c);
    };
    walk(node);
    return hashes;
}

export function getFolderCheckState(node: VFSFolder, wadPath: string, checkedFiles: Set<string>): 'none' | 'some' | 'all' {
    let hasChecked = false;
    let hasUnchecked = false;
    const walk = (n: VFSNode): boolean => {
        if (n.type === 'file') {
            if (checkedFiles.has(makeFileKey(wadPath, n.chunk.hash))) hasChecked = true;
            else hasUnchecked = true;
            return !(hasChecked && hasUnchecked);
        }
        for (const c of n.children) { if (!walk(c)) return false; }
        return true;
    };
    walk(node);
    if (hasChecked && hasUnchecked) return 'some';
    return hasChecked ? 'all' : 'none';
}

export function getWadCheckState(wad: WadExplorerWad, checkedFiles: Set<string>): 'none' | 'some' | 'all' {
    if (wad.status !== 'loaded' || wad.chunks.length === 0) return 'none';
    let hasChecked = false;
    let hasUnchecked = false;
    for (const c of wad.chunks) {
        if (checkedFiles.has(makeFileKey(wad.path, c.hash))) hasChecked = true;
        else hasUnchecked = true;
        if (hasChecked && hasUnchecked) return 'some';
    }
    return hasChecked ? 'all' : 'none';
}

export function getCheckStateForKeys(keys: string[], checkedFiles: Set<string>): 'none' | 'some' | 'all' {
    if (keys.length === 0) return 'none';
    let checked = 0;
    for (const k of keys) {
        if (checkedFiles.has(k)) checked++;
    }
    if (checked === 0) return 'none';
    if (checked === keys.length) return 'all';
    return 'some';
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick-action card config
// ─────────────────────────────────────────────────────────────────────────────

export const QUICK_ACTIONS = [
    { label: 'Textures', regex: /\.(dds|tex|png|jpg|jpeg)$/i, iconHtml: getIcon('texture') },
    { label: 'BIN Files', regex: /\.bin$/i, iconHtml: getIcon('bin') },
    { label: 'Audio', regex: /\.(bnk|wpk)$/i, iconHtml: getIcon('audio') },
    { label: 'Models', regex: /\.(skn|skl|scb|sco)$/i, iconHtml: getIcon('model') },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Preview types + magic-byte detection
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewData {
    fileType: string;
    bytes: Uint8Array;
    imageUrl: string | null;
    /** Decoded DDS/TEX pixels, rendered on a canvas (no PNG round trip). */
    bitmap: ImageBitmap | null;
    text: string | null;
    dims: [number, number] | null;
}

export function detectType(bytes: Uint8Array, pathHint: string | null): string {
    const ext = pathHint?.split('.').pop()?.toLowerCase() ?? '';
    if (bytes.length >= 4) {
        const b = bytes;
        if (b[0] === 0x54 && b[1] === 0x45 && b[2] === 0x58 && b[3] === 0x00) return 'image/tex';
        if (b[0] === 0x44 && b[1] === 0x44 && b[2] === 0x53 && b[3] === 0x20) return 'image/dds';
        if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
        if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
        if (b[0] === 0x1b && b[1] === 0x4c && b[2] === 0x75 && b[3] === 0x61) return 'application/x-luabin';
        const magic = String.fromCharCode(b[0], b[1], b[2], b[3]);
        if (magic === 'PROP' || magic === 'PTCH') return 'application/x-bin';
        if (b[0] === 0x52 && b[1] === 0x53 && b[2] === 0x54) return 'application/x-rst'; // 'R' 'S' 'T'
    }
    const extMap: Record<string, string> = {
        dds: 'image/dds', tex: 'image/tex', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        bin: 'application/x-bin', json: 'application/json', txt: 'text/plain', lua: 'text/x-lua',
        xml: 'application/xml', js: 'text/javascript', ts: 'text/typescript',
        skn: 'model/x-lol-skn', skl: 'model/x-lol-skl', scb: 'model/x-lol-scb', sco: 'model/x-lol-sco',
        anm: 'animation/x-lol-anm', bnk: 'audio/x-wwise-bnk', wpk: 'audio/x-wwise-wpk',
        luabin: 'application/x-luabin', luabin64: 'application/x-luabin', troybin: 'application/x-troybin',
        inibin: 'application/x-inibin', rst: 'application/x-rst', preload: 'text/plain', ini: 'text/plain',
    };
    return extMap[ext] ?? 'application/octet-stream';
}

// ─────────────────────────────────────────────────────────────────────────────
// Virtualized list config + flat-row types for renderer
// ─────────────────────────────────────────────────────────────────────────────

export const ROW_HEIGHT = 26;
export const OVERSCAN = 8;

export type FlatRow =
    | { kind: 'category'; cat: string; loadedCount: number; totalCount: number }
    | { kind: 'wad'; wad: WadExplorerWad }
    | { kind: 'wad-loading'; wadPath: string }
    | { kind: 'wad-error'; wadPath: string; error: string }
    | { kind: 'folder'; node: VFSFolder; effectiveNode: VFSFolder; displayPath: string; wadPath: string; depth: number }
    | { kind: 'file'; node: VFSFile; depth: number };

export type FlatSearchRow =
    | { kind: 'search-wad'; wadPath: string; wadName: string; totalMatches: number; folders: Array<{ folderPath: string; files: Array<{ chunk: WadChunk; fileName: string }> }> }
    | { kind: 'search-folder'; wadPath: string; folderPath: string; fileCount: number }
    | { kind: 'search-file'; wadPath: string; chunk: WadChunk; fileName: string; folderPath: string };

export function compactVFSNode(node: VFSFolder): { displayPath: string; effectiveNode: VFSFolder } {
    let current = node;
    const parts = [current.name];
    while (
        current.children.length === 1 &&
        current.children[0].type === 'folder'
    ) {
        current = current.children[0];
        parts.push(current.name);
    }
    return { displayPath: parts.join('/'), effectiveNode: current };
}

export function collectAllVFSFolderKeys(node: VFSNode): string[] {
    if (node.type !== 'folder') return [];
    const result = [node.key];
    for (const child of node.children) {
        result.push(...collectAllVFSFolderKeys(child));
    }
    return result;
}

export function findWadPath(node: VFSNode): string | null {
    if (node.type === 'file') return node.wadPath;
    for (const c of node.children) { const r = findWadPath(c); if (r) return r; }
    return null;
}

export function flattenTree(
    categories: [string, WadExplorerWad[]][],
    collapsedCategories: Set<string>,
    expandedWads: Set<string>,
    expandedFolders: Set<string>,
    wadSubtrees: Map<string, VFSNode[]>,
): FlatRow[] {
    const rows: FlatRow[] = [];
    for (const [cat, wads] of categories) {
        const loadedCount = wads.filter(w => w.status === 'loaded').length;
        rows.push({ kind: 'category', cat, loadedCount, totalCount: wads.length });
        if (collapsedCategories.has(cat)) continue;

        for (const wad of wads) {
            rows.push({ kind: 'wad', wad });
            const isExp = expandedWads.has(wad.path);
            if (!isExp) continue;

            if (wad.status === 'loading') {
                rows.push({ kind: 'wad-loading', wadPath: wad.path });
                continue;
            }
            if (wad.status === 'error') {
                rows.push({ kind: 'wad-error', wadPath: wad.path, error: wad.error ?? 'Failed to load' });
                continue;
            }
            if (wad.status !== 'loaded') continue;

            const subtree = wadSubtrees.get(wad.path) ?? [];
            const walkNodes = (nodes: VFSNode[], depth: number) => {
                for (const node of nodes) {
                    if (node.type === 'file') {
                        rows.push({ kind: 'file', node, depth });
                    } else {
                        const { displayPath, effectiveNode } = compactVFSNode(node);
                        const wadP = findWadPath(effectiveNode);
                        rows.push({ kind: 'folder', node, effectiveNode, displayPath, wadPath: wadP ?? '', depth });
                        if (expandedFolders.has(effectiveNode.key)) {
                            walkNodes(effectiveNode.children, depth + 1);
                        }
                    }
                }
            };
            walkNodes(subtree, 1);
        }
    }
    return rows;
}

export function flattenSearchResults(
    groups: Array<{
        wadPath: string;
        wadName: string;
        folders: Array<{ folderPath: string; files: Array<{ chunk: WadChunk; fileName: string }> }>;
        totalMatches: number;
    }>,
    collapsedSearchWads: Set<string>,
    collapsedSearchFolders: Set<string>,
): FlatSearchRow[] {
    const rows: FlatSearchRow[] = [];
    for (const group of groups) {
        rows.push({ kind: 'search-wad', wadPath: group.wadPath, wadName: group.wadName, totalMatches: group.totalMatches, folders: group.folders });
        if (collapsedSearchWads.has(group.wadPath)) continue;

        for (const folder of group.folders) {
            const folderKey = `${group.wadPath}::s::${folder.folderPath}`;
            if (folder.folderPath !== '') {
                rows.push({ kind: 'search-folder', wadPath: group.wadPath, folderPath: folder.folderPath, fileCount: folder.files.length });
            }
            if (!collapsedSearchFolders.has(folderKey)) {
                for (const f of folder.files) {
                    rows.push({ kind: 'search-file', wadPath: group.wadPath, chunk: f.chunk, fileName: f.fileName, folderPath: folder.folderPath });
                }
            }
        }
    }
    return rows;
}
