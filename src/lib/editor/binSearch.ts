export interface SearchOptions {
    caseSensitive: boolean;
    wholeWord: boolean;
    regex: boolean;
}

export interface SearchHit {
    /** 1-based line. */
    line: number;
    /** 1-based column of the match start. */
    column: number;
    length: number;
    preview: string;
}

export interface SearchGroup {
    path: string;
    label: string;
    editable: boolean;
    hits: SearchHit[];
    /** Set when a regex query is invalid for this run. */
    error?: string;
}

const MAX_HITS_PER_FILE = 500;
const PREVIEW_MAX = 160;

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The query as a global RegExp, or `null` when it cannot compile.
 *
 * Whole-word uses lookarounds rather than `\b` so it also bounds a query that
 * starts or ends with a non-word character — BIN text is full of `0x…` and
 * `"path/like/this"`, where `\b` lands in the wrong place.
 */
export function compileQuery(query: string, options: SearchOptions): RegExp | null {
    if (!query) return null;
    let body = options.regex ? query : escapeRegex(query);
    if (options.wholeWord) body = `(?<![\\w])(?:${body})(?![\\w])`;
    try {
        return new RegExp(body, options.caseSensitive ? 'g' : 'gi');
    } catch {
        return null;
    }
}

export function searchText(text: string, pattern: RegExp): SearchHit[] {
    const hits: SearchHit[] = [];
    const lines = text.split('\n');

    for (let i = 0; i < lines.length && hits.length < MAX_HITS_PER_FILE; i++) {
        const line = lines[i];
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
            hits.push({
                line: i + 1,
                column: match.index + 1,
                length: match[0].length,
                preview: line.trim().slice(0, PREVIEW_MAX),
            });
            if (match[0].length === 0) pattern.lastIndex++;
            if (hits.length >= MAX_HITS_PER_FILE) break;
        }
    }

    return hits;
}

export function totalHits(groups: SearchGroup[]): number {
    return groups.reduce((sum, group) => sum + group.hits.length, 0);
}

/** Replace every match in `text`, with `$1`-style backreferences for a regex query. */
export function replaceAll(text: string, pattern: RegExp, replacement: string): string {
    pattern.lastIndex = 0;
    return text.replace(pattern, replacement);
}
