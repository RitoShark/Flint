import type { TypeFix } from '../api/audit';

export interface TypeFixTarget {
    line: number;
    content: string;
}

export interface TypeFixEdit {
    line: number;
    startColumn: number;
    endColumn: number;
    text: string;
}

export interface TypeFixPlan {
    edits: TypeFixEdit[];
    /** Flagged lines that no longer declare what the check saw, so nothing is written to them. */
    stale: number[];
}

const HEX_TOKEN = /^0x[0-9a-f]{1,8}$/i;

/** The numeric ID a written class/field token stands for, matching `checks.rs::token_id`. */
export function tokenId(written: string): number {
    const token = written.trim().replace(/^"+|"+$/g, '');
    if (HEX_TOKEN.test(token)) return parseInt(token.slice(2), 16) >>> 0;
    const lower = token.toLowerCase();
    let hash = 0x811c9dc5;
    for (let i = 0; i < lower.length; i++) {
        hash = (hash ^ lower.charCodeAt(i)) >>> 0;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function normalizeType(declared: string): string {
    return declared.replace(/\s+/g, '').toLowerCase();
}

/**
 * Where the declared type sits on each line a retype finding flagged.
 *
 * Findings are computed from the SAVED file, so a line is only edited when it still declares
 * the same field with the same type. Anything else is reported as stale rather than written
 * over: after an edit above it, the flagged line number can point at a different declaration
 * that happens to carry the same type.
 */
export function planTypeFix(
    targets: TypeFixTarget[],
    fix: Pick<TypeFix, 'field' | 'from' | 'to'>,
): TypeFixPlan {
    const wantField = tokenId(fix.field);
    const wantType = normalizeType(fix.from);
    const edits: TypeFixEdit[] = [];
    const stale: number[] = [];

    for (const { line, content } of targets) {
        const colon = content.indexOf(':');
        const equals = colon < 0 ? -1 : content.indexOf('=', colon + 1);
        if (colon < 0 || equals < 0 || tokenId(content.slice(0, colon)) !== wantField) {
            stale.push(line);
            continue;
        }
        const declared = content.slice(colon + 1, equals);
        if (normalizeType(declared) !== wantType) {
            stale.push(line);
            continue;
        }
        const start = colon + 1 + (declared.length - declared.trimStart().length);
        const end = colon + 1 + declared.trimEnd().length;
        edits.push({ line, startColumn: start + 1, endColumn: end + 1, text: fix.to });
    }

    return { edits, stale };
}
