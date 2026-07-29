/**
 * Turns a flat list of file records into something `list(dir)` can answer in
 * O(children) instead of rebuilding a whole tree.
 *
 * Archive mounts get one flat list of chunk paths up front. The old browsers
 * re-derived a full nested tree from that on every render and every keystroke,
 * which is fine for a champion WAD and painful for a 40k-chunk one. Indexing
 * once and answering per-level keeps the cost proportional to what is on screen.
 */

import { UNKNOWN_DIR, type VfsEntry, type VfsFileRecord } from './types';

/** Normalise separators and strip leading/trailing slashes. */
export function normalizeDir(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function parentOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i);
}

function nameOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i === -1 ? path : path.slice(i + 1);
}

export class PathIndex {
    /** dir path → entries directly inside it. */
    private readonly children = new Map<string, VfsEntry[]>();
    /** Every file entry, for search. */
    private readonly files: VfsEntry[] = [];
    private sorted = false;

    constructor(records: Iterable<VfsFileRecord>) {
        for (const record of records) {
            const raw = record.path ? normalizeDir(record.path) : '';
            // A chunk whose hash never resolved has no path to place it under, so
            // it goes in one synthetic folder instead of vanishing from the tree.
            const path = raw === '' ? `${UNKNOWN_DIR}/${record.key}` : raw;

            const entry: VfsEntry = {
                path,
                name: nameOf(path),
                isDirectory: false,
                size: record.size,
                key: record.key,
            };
            this.files.push(entry);
            this.push(parentOf(path), entry);
            this.ensureDirChain(parentOf(path));
        }
    }

    /** Create every ancestor directory entry so intermediate levels resolve. */
    private ensureDirChain(dir: string): void {
        let current = dir;
        while (current !== '') {
            const parent = parentOf(current);
            const siblings = this.children.get(parent);
            if (!siblings?.some((e) => e.isDirectory && e.path === current)) {
                this.push(parent, {
                    path: current,
                    name: nameOf(current),
                    isDirectory: true,
                    key: current,
                });
            }
            current = parent;
        }
    }

    private push(dir: string, entry: VfsEntry): void {
        const list = this.children.get(dir);
        if (list) list.push(entry);
        else this.children.set(dir, [entry]);
        this.sorted = false;
    }

    /** Folders first, then files, each alphabetical — the order every surface used. */
    private sortAll(): void {
        if (this.sorted) return;
        for (const list of this.children.values()) {
            list.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
        }
        this.sorted = true;
    }

    list(dir: string): VfsEntry[] {
        this.sortAll();
        return this.children.get(normalizeDir(dir)) ?? [];
    }

    /** Every file in the mount, in insertion order. */
    allFiles(): readonly VfsEntry[] {
        return this.files;
    }

    /** Files whose path matches `predicate`, flat (search mode renders flat). */
    filter(predicate: (entry: VfsEntry) => boolean): VfsEntry[] {
        return this.files.filter(predicate);
    }

    get fileCount(): number {
        return this.files.length;
    }
}
