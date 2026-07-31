import { scanLineBraces, type BraceCursor } from './blockExtraction';

/*
Ritobin's text form makes a brace's role decidable from its line, which is what lets this
check work block-by-block instead of counting. Per rs_bin's printer
(crates/rs_bin/src/text/print.rs): vec2/vec3/vec4/rgba are emitted as one-line `{ a, b, c }`
literals; structs and non-empty containers emit `{` then a newline; empty containers emit
`{}`. Mtx44 is the sole multi-line value brace and is handled as a named exception.

The checker deliberately UNDER-reports: a false positive blocks saving, so anything ambiguous
is left to rs_bin, which reports `line N` on save.
*/

const CLOSER_FOR: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const OPENER_FOR: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

export interface BracketIssue {
    line: number;
    column: number;
    char: string;
    message: string;
    suggestLine: number;
}

export interface BracketCheckResult {
    valid: boolean;
    errors: BracketIssue[];
}

interface Frame {
    char: string;
    line: number;   // 1-based header line
    column: number; // 1-based
    indent: number; // header indent width
    label: string;  // class name, or '' when the line has none
    sawDeeper: boolean; // true once a content line strictly deeper than `indent` was seen
}

const INDENT_RE = /^(\s*)/;
const CLASS_RE = /([A-Za-z_]\w*)\s*\{\s*$/;

function indentWidth(line: string): number {
    return INDENT_RE.exec(line)?.[1].length ?? 0;
}

/** The class name on a scope-opening line, e.g. `VfxAnimatedVector3fVariableData {` → the name. */
function classNameOf(codeText: string): string {
    return CLASS_RE.exec(codeText)?.[1] ?? '';
}

function isBlankOrComment(line: string): boolean {
    const t = line.trim();
    return t === '' || t.startsWith('#') || t.startsWith('//');
}

/**
 * True when the line's code is nothing but closing brackets. Such a line sits at the indent of
 * the frame its own closer is about to pop legitimately (that pop is handled by the brace scan
 * below, not by recovery) — but any frame still deeper than it on the stack is orphaned and
 * must still be recovered.
 */
function isOnlyClosers(code: string): boolean {
    const t = code.trim();
    return t.length > 0 && /^[}\])\s]+$/.test(t);
}

export function checkRitobinBrackets(text: string): BracketCheckResult {
    const lines = text.split('\n');
    const errors: BracketIssue[] = [];
    const stack: Frame[] = [];
    let cursor: BraceCursor = { inString: false };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNo = i + 1;

        const braces: Array<{ ch: string; col: number }> = [];
        const scan = scanLineBraces(line, cursor, (ch, col) => braces.push({ ch, col }));
        cursor = { inString: scan.inString };

        const code = line.slice(0, scan.codeEnd);

        /*
        Resynchronise on indentation — but only where indentation is actually evidence.
        rs_bin's text parser (crates/rs_bin/src/text/parse.rs) is indentation-INSENSITIVE:
        whitespace is just a token separator, so a brace-balanced document with irregular
        indentation is perfectly valid to the real parser even though it "looks" broken here.
        An indent drop only means something for a frame that has already demonstrated it
        indents its own body consistently, i.e. we've already seen a content line strictly
        deeper than the frame's header. Without that evidence (`sawDeeper`), a frame falls back
        to the pre-recovery behavior: reported unclosed at end-of-scan, never mid-file.

        A non-blank line whose indent falls to or below such a frame's header indent means that
        frame's closer is missing: report it and pop, so the break stays local to its block
        instead of cascading through everything after it. Only `{` scopes opened on an EARLIER
        line are eligible — `[` and `(` never span lines in ritobin, so indentation says nothing
        about them.

        A line that is only closing brackets sits at the indent of the frame it is about to pop
        for real (via the brace scan below), so that ONE frame must not be recovered here — but
        anything still deeper than it on the stack is still orphaned and must be.
        */
        if (!isBlankOrComment(line)) {
            const ind = indentWidth(line);
            const onlyClosers = isOnlyClosers(code);

            const current = stack[stack.length - 1];
            if (current && current.char === '{' && current.line < lineNo && ind > current.indent) {
                current.sawDeeper = true;
            }

            while (stack.length > 0) {
                const top = stack[stack.length - 1];
                if (top.char !== '{' || top.line >= lineNo || !top.sawDeeper) break;
                if (onlyClosers ? ind >= top.indent : ind > top.indent) break;
                errors.push(unclosedIssue(top, lines));
                stack.pop();
            }
        }

        for (let b = 0; b < braces.length; b++) {
            const { ch, col } = braces[b];

            if (CLOSER_FOR[ch]) {
                // An opener that is matched by a closer later on THIS line is a value
                // literal (`{ 1, 2, 3 }`) — self-contained, never a scope.
                const closesHere = findInlineMatch(braces, b, ch);
                if (closesHere !== -1) {
                    b = closesHere; // skip past its closer
                    continue;
                }
                stack.push({
                    char: ch,
                    line: lineNo,
                    column: col + 1,
                    indent: indentWidth(line),
                    label: ch === '{' ? classNameOf(code) : '',
                    sawDeeper: false,
                });
                continue;
            }

            // A closer. Its inline-matched partner was consumed above, so reaching here
            // means it should close a frame from an earlier line.
            const expectedOpener = OPENER_FOR[ch];
            const top = stack[stack.length - 1];

            if (!top) {
                errors.push({
                    line: lineNo,
                    column: col + 1,
                    char: ch,
                    message: `Unexpected '${ch}' — there is no open block for it to close`,
                    suggestLine: lineNo,
                });
                continue;
            }

            if (top.char !== expectedOpener) {
                errors.push({
                    line: lineNo,
                    column: col + 1,
                    char: ch,
                    message: `Expected '${CLOSER_FOR[top.char]}' to close ${describeFrame(top)}, but found '${ch}'`,
                    suggestLine: lineNo,
                });
                continue;
            }

            stack.pop();
        }
    }

    for (let i = stack.length - 1; i >= 0; i--) {
        errors.push(unclosedIssue(stack[i], lines));
    }

    errors.sort((a, b) => a.line - b.line || a.column - b.column);
    return { valid: errors.length === 0, errors };
}

/** Index of the closer matching `braces[open]` on the same line, or -1. */
function findInlineMatch(
    braces: Array<{ ch: string; col: number }>,
    open: number,
    ch: string,
): number {
    const wanted = CLOSER_FOR[ch];
    let depth = 0;
    for (let i = open; i < braces.length; i++) {
        const c = braces[i].ch;
        if (c === ch) depth++;
        else if (c === wanted) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function describeFrame(f: Frame): string {
    return f.label ? `${f.label} (opened line ${f.line})` : `the block opened at line ${f.line}`;
}

/** Last line belonging to `frame`, by indentation — where its closer should go. */
function blockEndLine(frame: Frame, lines: string[]): number {
    let end = frame.line - 1;
    for (let j = frame.line; j < lines.length; j++) {
        if (isBlankOrComment(lines[j])) continue;
        if (indentWidth(lines[j]) <= frame.indent) break;
        end = j;
    }
    return end + 1;
}

function unclosedIssue(frame: Frame, lines: string[]): BracketIssue {
    const suggestLine = blockEndLine(frame, lines);
    return {
        line: frame.line,
        column: frame.column,
        char: frame.char,
        message: `${describeFrame(frame)} is never closed — add '${CLOSER_FOR[frame.char]}' after line ${suggestLine}`,
        suggestLine,
    };
}
