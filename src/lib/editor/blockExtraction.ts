/**
 * Ritobin block extraction & insertion helpers.
 *
 * Pure, unit-testable functions used by the BIN editor's "copy emitter block"
 * context actions and the left-side palette's drag-drop insertion.
 *
 * The brace scanning here is string/comment-aware (lifted from the editor's
 * `validateBrackets`) — a naive `{`/`}` counter would wrongly open/close blocks
 * on braces that live inside quoted strings or `#` / `//` comments.
 */

const BRACKET_PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const CLOSING_BRACKETS = new Set(['}', ']', ')']);
const OPEN_FOR_CLOSE: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

/** Header line that opens a (optionally path/hash-keyed) class block: `… ClassName {`. */
const HEADER_RE = /^\s*(?:"[^"]*"\s*=\s*|0x[0-9a-fA-F]+\s*=\s*|[A-Za-z_]\w*\s*:\s*(?:embed|pointer)\s*=\s*)?([A-Za-z_]\w*)\s*\{/;

export interface EnclosingBlock {
    /** 1-based line of the header (`ClassName {`). */
    startLine: number;
    /** 1-based line of the matching closing `}`. */
    endLine: number;
    /** Raw header line text. */
    headerText: string;
    /** The matched class name. */
    className: string;
    /** Full block text from header line through the closing `}` line (inclusive). */
    blockText: string;
}

interface BraceCursor {
    inString: boolean;
}

/**
 * Walk a single line's characters, toggling string state and invoking `onBrace`
 * for each real (non-string, non-comment) bracket. Returns updated cursor.
 */
function scanLineBraces(
    line: string,
    cursor: BraceCursor,
    onBrace: (ch: string, col: number) => void,
): BraceCursor {
    let { inString } = cursor;
    for (let col = 0; col < line.length; col++) {
        const ch = line[col];

        if (!inString) {
            if (ch === '#') break;
            if (ch === '/' && col + 1 < line.length && line[col + 1] === '/') break;
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
    return { inString };
}

/**
 * Forward-match the `{` opened on `headerLineIdx` (0-based) to its closing `}`.
 * String/comment-aware. Returns the 0-based line index of the closing brace, or
 * -1 if unbalanced.
 *
 * Assumes the header line's first real `{` is the one to match.
 */
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
            // We only care about curly nesting for block matching; '[' / '(' don't
            // affect the curly depth and are tracked purely by the depth counter
            // above (they never decrement curly depth).
        });
        if (started && depth === 0) return closedAt === -1 ? i : closedAt;
    }
    return -1;
}

/**
 * Scan UP from `line` (1-based) for the nearest header that ENCLOSES the cursor,
 * optionally restricted to `classFilter`. Returns the enclosing block, or null.
 *
 * "Encloses" = the header's matching `}` is at or after `line`.
 *
 * When `outermost` is true, keep walking up past the first match to find the
 * outermost enclosing header that still satisfies `classFilter` (used by
 * "copy full VfxEmitter / VfxSystem").
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
        // Must actually enclose the cursor line.
        if (closeIdx < cursorIdx) continue;

        const block: EnclosingBlock = {
            startLine: i + 1,
            endLine: closeIdx + 1,
            headerText: lines[i],
            className,
            blockText: lines.slice(i, closeIdx + 1).join('\n'),
        };

        if (!outermost) return block;
        // Keep the outermost: remember this one and continue scanning up.
        best = block;
    }

    return best;
}

/**
 * Strip the block's common leading indentation and re-prefix each line with
 * `targetIndent`. The first (header) line is treated as the indent baseline.
 * Blank lines stay blank.
 */
export function reindentBlock(blockText: string, targetIndent: string): string {
    const lines = blockText.split('\n');
    if (lines.length === 0) return blockText;

    // Baseline = leading whitespace of the first non-blank line (the header).
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
 * If the block declares an `emitterName: string = "X"` that already appears as
 * an emitterName in `targetText`, rename it to `"X_copy"`, `"X_copy2"`, … so the
 * inserted block doesn't collide.
 *
 * Only rewrites the FIRST emitterName assignment in the block (the emitter's own
 * name) — nested references stay untouched.
 */
export function renameEmitterIfCollision(blockText: string, targetText: string): string {
    const nameRe = /(emitterName:\s*string\s*=\s*")([^"]*)(")/;
    const m = nameRe.exec(blockText);
    if (!m) return blockText;
    const original = m[2];

    // Collect every emitterName already present in the target.
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

    // Replace only the first occurrence (the emitter's own name).
    return blockText.replace(nameRe, `$1${candidate}$3`);
}

export interface InsertPosition {
    /** 1-based line AFTER which the block should be spliced (insert a newline + block). */
    line: number;
    /** Indentation to apply to the inserted block's header line. */
    indent: string;
}

/**
 * Decide where to splice a copied block when dropped near `dropLine` (1-based).
 *
 * Walks the curly-brace stack down to `dropLine` and finds the nearest enclosing
 * `list[embed] = { … }` body (the canonical container for anonymous
 * `ClassName {` items, e.g. an emitter list). If found, the block is inserted as
 * a new list item indented one level inside that list; if not, it's inserted at
 * the drop line at top-level (zero) indent.
 *
 * `getStack` mirrors the editor's `getBracketStackAtLine` so callers can pass the
 * real scanner; a built-in fallback is provided for tests.
 */
export function computeInsertPosition(
    text: string,
    dropLine: number,
    getStack: (text: string, upToLine: number) => { char: string; line: number; indent: string }[] = defaultBracketStack,
): InsertPosition {
    const lines = text.split('\n');
    const clampedDrop = Math.min(Math.max(dropLine, 1), lines.length);
    const stack = getStack(text, clampedDrop);

    // Find the innermost open `{` whose header line is a `list[embed] = {`.
    for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i];
        if (entry.char !== '{') continue;
        const headerLine = lines[entry.line - 1] ?? '';
        if (/list\s*\[\s*(?:embed|pointer)\s*\]\s*=\s*\{/.test(headerLine)) {
            // Insert inside this list body, one indent level deeper than the list header.
            return { line: clampedDrop, indent: entry.indent + '    ' };
        }
    }

    // No enclosing list — drop at top level with the drop line's own indent.
    const dropIndent = lines[clampedDrop - 1]?.match(/^(\s*)/)?.[1] ?? '';
    return { line: clampedDrop, indent: dropIndent };
}

/** Fallback bracket-stack scanner (string/comment-aware), mirrors the editor's. */
function defaultBracketStack(
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
