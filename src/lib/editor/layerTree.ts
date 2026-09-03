import type { LayerCategory, LayerFile } from '../api';

export interface TreeRow {
    path: string;
    name: string;
    depth: number;
    isDir: boolean;
    /** Half-open range into `files` covering every file at or under this row. */
    start: number;
    end: number;
    bytes: number;
    category: LayerCategory | null;
}

export interface LayerTree {
    /** Files reordered so every directory owns a contiguous range. */
    files: LayerFile[];
    /** Depth-first row order: a directory immediately followed by its subtree. */
    rows: TreeRow[];
    /** Prefix sums over `files` byte sizes, length `files.length + 1`. */
    sizePrefix: Float64Array;
    byCategory: Record<LayerCategory, number[]>;
}

interface Dir {
    name: string;
    dirs: Map<string, Dir>;
    files: LayerFile[];
}

const EMPTY_CATEGORIES = (): Record<LayerCategory, number[]> => ({
    animation: [],
    model: [],
    particle: [],
    audio: [],
    data: [],
    other: [],
});

function newDir(name: string): Dir {
    return { name, dirs: new Map(), files: [] };
}

export function buildLayerTree(input: LayerFile[]): LayerTree {
    const root = newDir('');
    for (const file of input) {
        const segments = file.path.split('/');
        let dir = root;
        for (let i = 0; i < segments.length - 1; i += 1) {
            const segment = segments[i];
            let child = dir.dirs.get(segment);
            if (!child) {
                child = newDir(segment);
                dir.dirs.set(segment, child);
            }
            dir = child;
        }
        dir.files.push(file);
    }

    const files: LayerFile[] = [];
    const rows: TreeRow[] = [];
    const byCategory = EMPTY_CATEGORIES();

    const walk = (dir: Dir, prefix: string, depth: number) => {
        const dirNames = [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b));
        for (const name of dirNames) {
            const child = dir.dirs.get(name)!;
            const path = prefix ? `${prefix}/${name}` : name;
            const row: TreeRow = {
                path,
                name,
                depth,
                isDir: true,
                start: files.length,
                end: files.length,
                bytes: 0,
                category: null,
            };
            rows.push(row);
            walk(child, path, depth + 1);
            row.end = files.length;
        }
        const sorted = [...dir.files].sort((a, b) => a.path.localeCompare(b.path));
        for (const file of sorted) {
            const index = files.length;
            files.push(file);
            byCategory[file.category].push(index);
            rows.push({
                path: file.path,
                name: file.path.slice(file.path.lastIndexOf('/') + 1),
                depth,
                isDir: false,
                start: index,
                end: index + 1,
                bytes: file.size,
                category: file.category,
            });
        }
    };
    walk(root, '', 0);

    const sizePrefix = new Float64Array(files.length + 1);
    for (let i = 0; i < files.length; i += 1) {
        sizePrefix[i + 1] = sizePrefix[i] + files[i].size;
    }
    for (const row of rows) {
        if (row.isDir) row.bytes = sizePrefix[row.end] - sizePrefix[row.start];
    }

    return { files, rows, sizePrefix, byCategory };
}

/** Prefix sums over the selection flags, so a directory's tally is O(1). */
export function selectionPrefix(selection: Uint8Array): Int32Array {
    const prefix = new Int32Array(selection.length + 1);
    for (let i = 0; i < selection.length; i += 1) {
        prefix[i + 1] = prefix[i] + selection[i];
    }
    return prefix;
}

export type CheckState = 'off' | 'partial' | 'on';

export function rangeState(prefix: Int32Array, start: number, end: number): CheckState {
    if (end <= start) return 'off';
    const count = prefix[end] - prefix[start];
    if (count === 0) return 'off';
    return count === end - start ? 'on' : 'partial';
}

export function indexState(prefix: Int32Array, indices: number[]): CheckState {
    if (indices.length === 0) return 'off';
    let count = 0;
    for (const i of indices) count += prefix[i + 1] - prefix[i];
    if (count === 0) return 'off';
    return count === indices.length ? 'on' : 'partial';
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
