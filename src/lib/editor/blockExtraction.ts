const BRACKET_PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const CLOSING_BRACKETS = new Set(['}', ']', ')']);
const OPEN_FOR_CLOSE: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

const HEADER_RE = /^\s*(?:"[^"]*"\s*=\s*|0x[0-9a-fA-F]+\s*=\s*|[A-Za-z_]\w*\s*:\s*(?:embed|pointer)\s*=\s*)?([A-Za-z_]\w*)\s*\{/;

export interface EnclosingBlock {
    /** 1-based line of the header (`ClassName {`). */
    startLine: number;
    /** 1-based line of the matching closing `}`. */
    endLine: number;
    headerText: string;
    className: string;
    /** Full block text from header line through the closing `}` line (inclusive). */
    blockText: string;
}

export interface BraceCursor {
    inString: boolean;
}

/**
 * Scans one line for braces, honouring strings and `#` / `//` comments.
 * `codeEnd` is the exclusive column where code stops — the comment marker, or
 * the line length. Callers that need to know whether a brace is the last code
 * on its line use it instead of re-scanning.
 */
export function scanLineBraces(
    line: string,
    cursor: BraceCursor,
    onBrace: (ch: string, col: number) => void,
): { inString: boolean; codeEnd: number } {
    let { inString } = cursor;
    let codeEnd = line.length;

    for (let col = 0; col < line.length; col++) {
        const ch = line[col];

        if (!inString) {
            if (ch === '#') { codeEnd = col; break; }
            if (ch === '/' && col + 1 < line.length && line[col + 1] === '/') { codeEnd = col; break; }
        }

        if (ch === '"' && (col === 0 || line[col - 1] !== '\\')) {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (BRACKET_PAIRS[ch] || CLOSING_BRACKETS.has(ch)) {
            onBrace(ch, col);
        }
    }

    return { inString, codeEnd };
}

function matchClosingBrace(lines: string[], headerLineIdx: number): number {
    let depth = 0;
    let started = false;
    let cursor: BraceCursor = { inString: false };

    for (let i = headerLineIdx; i < lines.length; i++) {
        let closedAt = -1;
        cursor = scanLineBraces(lines[i], cursor, (ch) => {
            if (ch === '{') {
                depth++;
                started = true;
            } else if (ch === '}') {
                depth--;
                if (started && depth === 0 && closedAt === -1) closedAt = i;
            }
        });
        if (started && depth === 0) return closedAt === -1 ? i : closedAt;
    }
    return -1;
}

/**
 * Scan UP from `line` (1-based) for the nearest header that ENCLOSES the cursor.
 * When `outermost` is true, keep walking up to find the outermost enclosing
 * header that still satisfies `classFilter`.
 */
export function findEnclosingBlock(
    text: string,
    line: number,
    classFilter?: string[],
    outermost = false,
): EnclosingBlock | null {
    const lines = text.split('\n');
    const cursorIdx = Math.min(Math.max(line - 1, 0), lines.length - 1);
    const filterSet = classFilter && classFilter.length ? new Set(classFilter) : null;

    let best: EnclosingBlock | null = null;

    for (let i = cursorIdx; i >= 0; i--) {
        const m = HEADER_RE.exec(lines[i]);
        if (!m) continue;
        const className = m[1];
        if (filterSet && !filterSet.has(className)) continue;

        const closeIdx = matchClosingBrace(lines, i);
        if (closeIdx === -1) continue;
        if (closeIdx < cursorIdx) continue;

        const block: EnclosingBlock = {
            startLine: i + 1,
            endLine: closeIdx + 1,
            headerText: lines[i],
            className,
            blockText: lines.slice(i, closeIdx + 1).join('\n'),
        };

        if (!outermost) return block;
        best = block;
    }

    return best;
}

/**
 * Strip the block's common leading indentation and re-prefix each line with
 * `targetIndent`. The first (header) line is treated as the indent baseline.
 */
export function reindentBlock(blockText: string, targetIndent: string): string {
    const lines = blockText.split('\n');
    if (lines.length === 0) return blockText;

    let baseIndent = '';
    for (const l of lines) {
        if (l.trim() === '') continue;
        baseIndent = l.match(/^(\s*)/)?.[1] ?? '';
        break;
    }

    return lines
        .map((l) => {
            if (l.trim() === '') return '';
            const stripped = l.startsWith(baseIndent) ? l.slice(baseIndent.length) : l.replace(/^\s*/, '');
            return targetIndent + stripped;
        })
        .join('\n');
}

/**
 * If the block declares an `emitterName: string = "X"` that already appears in
 * `targetText`, rename it to `"X_copy"`, `"X_copy2"`, … so it doesn't collide.
 * Only the FIRST emitterName assignment in the block is rewritten.
 */
export function renameEmitterIfCollision(blockText: string, targetText: string): string {
    const nameRe = /(emitterName:\s*string\s*=\s*")([^"]*)(")/;
    const m = nameRe.exec(blockText);
    if (!m) return blockText;
    const original = m[2];

    const existing = new Set<string>();
    const allNamesRe = /emitterName:\s*string\s*=\s*"([^"]*)"/g;
    let nm: RegExpExecArray | null;
    while ((nm = allNamesRe.exec(targetText)) !== null) {
        existing.add(nm[1]);
    }

    if (!existing.has(original)) return blockText;

    let candidate = `${original}_copy`;
    let n = 2;
    while (existing.has(candidate)) {
        candidate = `${original}_copy${n}`;
        n++;
    }

    return blockText.replace(nameRe, `$1${candidate}$3`);
}

/**
 * Asset file extensions that, when a quoted string ends in one and contains a
 * `/`, mark that string as a reference to an on-disk asset file.
 */
export const ASSET_PATH_EXTENSIONS = [
    'dds', 'tex', 'scb', 'skn', 'sco', 'bnk', 'wpk', 'wem', 'anm', 'png', 'tga',
] as const;

const ASSET_EXT_SET = new Set<string>(ASSET_PATH_EXTENSIONS);

/**
 * Extract the distinct asset-file path strings referenced inside a ritobin
 * block: any double-quoted string value containing a `/` and ending in a known
 * asset extension. Returns paths in first-seen order, de-duplicated.
 */
export function extractAssetPaths(blockText: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const stringRe = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = stringRe.exec(blockText)) !== null) {
        const value = m[1];
        if (!value.includes('/') && !value.includes('\\')) continue;
        const dot = value.lastIndexOf('.');
        if (dot === -1) continue;
        const ext = value.slice(dot + 1).toLowerCase();
        if (!ASSET_EXT_SET.has(ext)) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

export interface InsertPosition {
    /** 1-based line AFTER which the block should be spliced (insert a newline + block). */
    line: number;
    indent: string;
}

/**
 * Decide where to splice a copied block when dropped near `dropLine` (1-based).
 * Finds the nearest enclosing `list[embed] = { … }` body and inserts one indent
 * level inside it; if none, inserts at the drop line with its own indent.
 */
export function computeInsertPosition(
    text: string,
    dropLine: number,
    getStack: (text: string, upToLine: number) => { char: string; line: number; indent: string }[] = bracketStackAtLine,
): InsertPosition {
    const lines = text.split('\n');
    const clampedDrop = Math.min(Math.max(dropLine, 1), lines.length);
    const stack = getStack(text, clampedDrop);

    for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i];
        if (entry.char !== '{') continue;
        const headerLine = lines[entry.line - 1] ?? '';
        if (/list\s*\[\s*(?:embed|pointer)\s*\]\s*=\s*\{/.test(headerLine)) {
            return { line: clampedDrop, indent: entry.indent + '    ' };
        }
    }

    const dropIndent = lines[clampedDrop - 1]?.match(/^(\s*)/)?.[1] ?? '';
    return { line: clampedDrop, indent: dropIndent };
}

export function bracketStackAtLine(
    text: string,
    upToLine: number,
): { char: string; line: number; indent: string }[] {
    const stack: { char: string; line: number; indent: string }[] = [];
    const lines = text.split('\n');
    const limit = Math.min(upToLine, lines.length);

    for (let lineIdx = 0; lineIdx < limit; lineIdx++) {
        const line = lines[lineIdx];
        let cursor: BraceCursor = { inString: false };
        cursor = scanLineBraces(line, cursor, (ch) => {
            if (BRACKET_PAIRS[ch]) {
                const indent = line.match(/^(\s*)/)?.[1] || '';
                stack.push({ char: ch, line: lineIdx + 1, indent });
            } else if (CLOSING_BRACKETS.has(ch)) {
                const expected = OPEN_FOR_CLOSE[ch];
                if (stack.length > 0 && stack[stack.length - 1].char === expected) {
                    stack.pop();
                }
            }
        });
        void cursor;
    }

    return stack;
}
