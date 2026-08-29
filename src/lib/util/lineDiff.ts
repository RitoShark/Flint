export interface LineDiff {
    /** 1-based line number in `a` where the change starts. */
    line: number;
    context_before: string[];
    removed: string[];
    added: string[];
    context_after: string[];
    /** Lines cut from the middle of oversized removed/added blocks. */
    truncated_removed: number;
    truncated_added: number;
}

const CONTEXT = 2;
const MAX_BLOCK = 200;

function capBlock(lines: string[]): { shown: string[]; truncated: number } {
    if (lines.length <= MAX_BLOCK) return { shown: lines, truncated: 0 };
    const half = MAX_BLOCK / 2;
    return {
        shown: [...lines.slice(0, half), ...lines.slice(lines.length - half)],
        truncated: lines.length - MAX_BLOCK,
    };
}

/**
 * Trims the common prefix and suffix and reports the middle as one
 * removed/added block. Not an LCS — a single edited region (the common case
 * for a tweaked bin) comes out exact, scattered edits merge into one hunk.
 */
export function simpleLineDiff(a: string, b: string): LineDiff | null {
    if (a === b) return null;
    const linesA = a.split('\n');
    const linesB = b.split('\n');

    let prefix = 0;
    const maxPrefix = Math.min(linesA.length, linesB.length);
    while (prefix < maxPrefix && linesA[prefix] === linesB[prefix]) prefix++;

    let suffix = 0;
    const maxSuffix = Math.min(linesA.length, linesB.length) - prefix;
    while (
        suffix < maxSuffix &&
        linesA[linesA.length - 1 - suffix] === linesB[linesB.length - 1 - suffix]
    ) {
        suffix++;
    }

    const removed = linesA.slice(prefix, linesA.length - suffix);
    const added = linesB.slice(prefix, linesB.length - suffix);
    if (removed.length === 0 && added.length === 0) return null;

    const cappedRemoved = capBlock(removed);
    const cappedAdded = capBlock(added);

    return {
        line: prefix + 1,
        context_before: linesA.slice(Math.max(0, prefix - CONTEXT), prefix),
        removed: cappedRemoved.shown,
        added: cappedAdded.shown,
        context_after: linesA.slice(linesA.length - suffix, linesA.length - suffix + CONTEXT),
        truncated_removed: cappedRemoved.truncated,
        truncated_added: cappedAdded.truncated,
    };
}
