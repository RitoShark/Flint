/**
 * Pure keyboard navigation over a flattened tree.
 *
 * FileTree already flattens its tree into an ordered `rows` array for
 * virtualization, and already keeps a selection Set and a range anchor for
 * Ctrl/Shift+click. This module supplies the index arithmetic so the keyboard
 * shares that exact model rather than inventing a parallel one — which is what
 * makes Shift+Arrow and Shift+click agree on what "the range" is.
 */

export interface NavRow {
    path: string;
    /** Leaf name, used for type-to-find. */
    name: string;
    isDirectory: boolean;
    isExpanded: boolean;
    depth: number;
}

/** What the caller should do in response to a horizontal arrow. */
export type ArrowOutcome =
    | { kind: 'expand'; path: string }
    | { kind: 'collapse'; path: string }
    | { kind: 'focus'; path: string };

export function indexOfPath(rows: NavRow[], path: string | null): number {
    if (path === null) return -1;
    return rows.findIndex((r) => r.path === path);
}

/**
 * Move `delta` rows, clamping at both ends.
 *
 * Deliberately clamps rather than wraps: a file list gives no visual cue that
 * you've jumped from the bottom back to the top, whereas the tab strip does.
 */
export function stepFocus(rows: NavRow[], path: string | null, delta: number): string | null {
    if (rows.length === 0) return null;

    const current = indexOfPath(rows, path);
    if (current < 0) return delta >= 0 ? rows[0].path : rows[rows.length - 1].path;

    const next = Math.min(rows.length - 1, Math.max(0, current + delta));
    return rows[next].path;
}

export function edgeFocus(rows: NavRow[], end: 'first' | 'last'): string | null {
    if (rows.length === 0) return null;
    return end === 'first' ? rows[0].path : rows[rows.length - 1].path;
}

/** Every path between two rows inclusive, in visible order regardless of direction. */
export function rangeBetween(rows: NavRow[], anchor: string, target: string): string[] {
    const i = indexOfPath(rows, anchor);
    const j = indexOfPath(rows, target);
    if (i < 0 || j < 0) return [];

    const [lo, hi] = i <= j ? [i, j] : [j, i];
    return rows.slice(lo, hi + 1).map((r) => r.path);
}

/**
 * ArrowRight: expand a closed folder, or step into an open one.
 *
 * Files do nothing rather than moving down — otherwise Right and Down would be
 * the same key on half the rows, which hides whether a folder actually opened.
 */
export function arrowRight(rows: NavRow[], path: string | null): ArrowOutcome | null {
    const i = indexOfPath(rows, path);
    if (i < 0) return null;

    const current = rows[i];
    if (!current.isDirectory) return null;
    if (!current.isExpanded) return { kind: 'expand', path: current.path };

    const child = rows[i + 1];
    if (!child || child.depth <= current.depth) return null;
    return { kind: 'focus', path: child.path };
}

/** ArrowLeft: collapse an open folder, else jump to the parent row. */
export function arrowLeft(rows: NavRow[], path: string | null): ArrowOutcome | null {
    const i = indexOfPath(rows, path);
    if (i < 0) return null;

    const current = rows[i];
    if (current.isDirectory && current.isExpanded) {
        return { kind: 'collapse', path: current.path };
    }

    // Nearest preceding row that is shallower — the parent in a flattened tree.
    for (let j = i - 1; j >= 0; j--) {
        if (rows[j].depth < current.depth) return { kind: 'focus', path: rows[j].path };
    }
    return null;
}

/**
 * Type-to-find: first row whose name starts with `buffer`, searching forward from
 * the focused row and wrapping once.
 */
export function typeToFind(rows: NavRow[], buffer: string, fromPath: string | null): string | null {
    const needle = buffer.trim().toLowerCase();
    if (!needle || rows.length === 0) return null;

    const start = indexOfPath(rows, fromPath) + 1;

    for (let n = 0; n < rows.length; n++) {
        const row = rows[(start + n) % rows.length];
        if (row.name.toLowerCase().startsWith(needle)) return row.path;
    }
    return null;
}
