export type DiffOp = 'ctx' | 'del' | 'add';

export interface DiffRow {
    op: DiffOp;
    /** 1-based line number in `a` (null on added rows). */
    a: number | null;
    /** 1-based line number in `b` (null on removed rows). */
    b: number | null;
    text: string;
}

export interface DiffHunk {
    aStart: number;
    aCount: number;
    bStart: number;
    bCount: number;
    rows: DiffRow[];
}

export interface LineDiffResult {
    hunks: DiffHunk[];
    added: number;
    removed: number;
    /** The pair was too far apart to align line-by-line; the result is one
     *  whole-block replacement instead of real hunks. */
    coarse: boolean;
    /** Hunks dropped past the display cap. */
    truncatedHunks: number;
}

export interface DiffOptions {
    context?: number;
    /** Stop emitting hunks past this many rows and report the rest as dropped. */
    maxRows?: number;
    /** Myers edit-distance ceiling; beyond it the diff falls back to coarse. */
    maxDistance?: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_ROWS = 4000;
const DEFAULT_MAX_DISTANCE = 2000;

interface Edit {
    op: DiffOp;
    text: string;
}

/** Myers O(ND) diff over two line arrays; null when the edit distance exceeds
 *  `maxD` (the caller then reports a coarse replacement). */
function myers(a: string[], b: string[], maxD: number): Edit[] | null {
    const n = a.length;
    const m = b.length;
    if (n === 0 && m === 0) return [];

    const limit = Math.min(n + m, maxD);
    const off = limit + 1;
    const v = new Int32Array(2 * off + 1);
    const trace: Int32Array[] = [];

    for (let d = 0; d <= limit; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
            else x = v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[off + k] = x;
            if (x >= n && y >= m) return backtrack(trace, a, b, d, off);
        }
    }
    return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], d: number, off: number): Edit[] {
    const out: Edit[] = [];
    let x = a.length;
    let y = b.length;

    for (let step = d; step > 0; step--) {
        const v = trace[step];
        const k = x - y;
        const prevK = k === -step || (k !== step && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
        const prevX = v[off + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { out.push({ op: 'ctx', text: a[x - 1] }); x--; y--; }
        if (x === prevX) { out.push({ op: 'add', text: b[y - 1] }); y--; }
        else { out.push({ op: 'del', text: a[x - 1] }); x--; }
    }
    while (x > 0 && y > 0) { out.push({ op: 'ctx', text: a[x - 1] }); x--; y--; }

    out.reverse();
    return out;
}

function splitLines(s: string): string[] {
    const lines = s.split('\n');
    // A trailing newline is a terminator, not an empty last line.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/**
 * Line diff with every changed region reported, not just the first.
 *
 * Common prefix/suffix are trimmed before the Myers pass so a small edit in a
 * huge bin costs almost nothing. Returns `null` when the two sides are equal.
 */
export function diffLines(a: string, b: string, opts: DiffOptions = {}): LineDiffResult | null {
    if (a === b) return null;

    const context = opts.context ?? DEFAULT_CONTEXT;
    const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;

    const linesA = splitLines(a);
    const linesB = splitLines(b);

    let prefix = 0;
    const maxPrefix = Math.min(linesA.length, linesB.length);
    while (prefix < maxPrefix && linesA[prefix] === linesB[prefix]) prefix++;

    let suffix = 0;
    const maxSuffix = maxPrefix - prefix;
    while (
        suffix < maxSuffix &&
        linesA[linesA.length - 1 - suffix] === linesB[linesB.length - 1 - suffix]
    ) {
        suffix++;
    }

    const midA = linesA.slice(prefix, linesA.length - suffix);
    const midB = linesB.slice(prefix, linesB.length - suffix);
    if (midA.length === 0 && midB.length === 0) return null;

    let coarse = false;
    let edits = myers(midA, midB, maxDistance);
    if (!edits) {
        coarse = true;
        edits = [
            ...midA.map((text): Edit => ({ op: 'del', text })),
            ...midB.map((text): Edit => ({ op: 'add', text })),
        ];
    }

    // Re-attach the trimmed prefix/suffix as context so hunks carry real
    // surroundings instead of starting flush at the first change.
    const rows: DiffRow[] = [];
    let aLine = 1;
    let bLine = 1;
    const pushCtx = (text: string) => {
        rows.push({ op: 'ctx', a: aLine++, b: bLine++, text });
    };
    for (let i = 0; i < prefix; i++) pushCtx(linesA[i]);
    for (const edit of edits) {
        if (edit.op === 'ctx') pushCtx(edit.text);
        else if (edit.op === 'del') rows.push({ op: 'del', a: aLine++, b: null, text: edit.text });
        else rows.push({ op: 'add', a: null, b: bLine++, text: edit.text });
    }
    for (let i = linesA.length - suffix; i < linesA.length; i++) pushCtx(linesA[i]);

    const added = rows.reduce((n, r) => (r.op === 'add' ? n + 1 : n), 0);
    const removed = rows.reduce((n, r) => (r.op === 'del' ? n + 1 : n), 0);
    if (added === 0 && removed === 0) return null;

    const all = groupHunks(rows, context);
    const hunks: DiffHunk[] = [];
    let shown = 0;
    for (const hunk of all) {
        if (shown + hunk.rows.length > maxRows && hunks.length > 0) break;
        hunks.push(hunk);
        shown += hunk.rows.length;
    }

    return { hunks, added, removed, coarse, truncatedHunks: all.length - hunks.length };
}

function groupHunks(rows: DiffRow[], context: number): DiffHunk[] {
    const changed: number[] = [];
    for (let i = 0; i < rows.length; i++) if (rows[i].op !== 'ctx') changed.push(i);
    if (changed.length === 0) return [];

    const spans: Array<[number, number]> = [];
    for (const idx of changed) {
        const start = Math.max(0, idx - context);
        const end = Math.min(rows.length - 1, idx + context);
        const last = spans[spans.length - 1];
        if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else spans.push([start, end]);
    }

    return spans.map(([start, end]) => {
        const slice = rows.slice(start, end + 1);
        const firstA = slice.find((r) => r.a !== null)?.a ?? 1;
        const firstB = slice.find((r) => r.b !== null)?.b ?? 1;
        return {
            aStart: firstA,
            aCount: slice.reduce((n, r) => (r.a !== null ? n + 1 : n), 0),
            bStart: firstB,
            bCount: slice.reduce((n, r) => (r.b !== null ? n + 1 : n), 0),
            rows: slice,
        };
    });
}
