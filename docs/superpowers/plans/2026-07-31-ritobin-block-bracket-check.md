# Block-aware ritobin bracket checking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace BinEditor's flat brace counter with a grammar-aware checker that reports the innermost broken *block* at its own header line, handles inline value literals, and recovers so one break doesn't mask others.

**Architecture:** A new pure module `src/lib/editor/bracketCheck.ts` classifies each brace by line shape (scope / value literal / closer) before matching, keeps a scope stack of frames carrying header line + indent, and resynchronises on indentation drops. `BinEditor.tsx` drops its three local brace helpers and calls the new module. `scanLineBraces` in `blockExtraction.ts` becomes the single shared scanner.

**Tech Stack:** TypeScript, React 18, Monaco, Vitest 3 (`npm test`).

Design doc: `docs/superpowers/specs/2026-07-31-ritobin-block-bracket-check-design.md`

## Global Constraints

- **A false positive blocks saving.** `handleSave` refuses to save while `bracketStatus.valid` is false, and that gate is being KEPT. The checker must never report an issue on text `rs_bin` would accept. When in doubt, stay silent and let rs_bin report `line N` on save.
- **Indent disagreement is never itself a trigger.** A closer is flagged only when there is genuinely no scope to close.
- **The UI contract is fixed.** Issues keep the fields `line`, `column`, `char`, `message`, `suggestLine`. The returned shape stays `{ valid, errors }`.
- **No AI attribution** in commits, code, or comments. Never sign commits.
- **Commit style:** Conventional Commits with the `bin-editor` scope, short imperative subject (e.g. `feat(bin-editor): …`).
- **Do not run `cargo build` / `cargo check`.** This is a frontend-only change; `npm test` and `npx tsc --noEmit` are the verification tools.
- Grammar authority is `crates/rs_bin/src/text/print.rs` in `E:\RitoShark\Tools\RitoShark-Crates`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/editor/bracketCheck.ts` (create) | The checker. Pure, no React/Monaco imports. |
| `src/lib/editor/bracketCheck.test.ts` (create) | Unit tests. |
| `src/lib/editor/blockExtraction.ts` (modify) | Export `scanLineBraces` + report where code ends on a line. |
| `src/components/preview/BinEditor.tsx` (modify) | Delete local helpers, call the new module, fix the status label. |

---

### Task 1: Shared scanner reports where code ends

`scanLineBraces` currently `break`s out of the line at `#` or `//`. The checker needs to know whether a brace is the *last code* on its line, so the scanner must report the column where code stops. This is additive — existing callers ignore the new field.

**Files:**
- Modify: `src/lib/editor/blockExtraction.ts:18-48`
- Test: `src/lib/editor/blockExtraction.test.ts`

**Interfaces:**
- Produces: `export interface BraceCursor { inString: boolean }` and
  `export function scanLineBraces(line: string, cursor: BraceCursor, onBrace: (ch: string, col: number) => void): { inString: boolean; codeEnd: number }`
  where `codeEnd` is the exclusive column index at which code stops (comment start, or `line.length`).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/editor/blockExtraction.test.ts`:

```typescript
import { scanLineBraces } from './blockExtraction';

describe('scanLineBraces', () => {
    it('reports codeEnd at the comment marker', () => {
        const r = scanLineBraces('    foo: u32 = 1 # trailing note', { inString: false }, () => {});
        expect(r.codeEnd).toBe(17);
    });

    it('reports codeEnd at line length when there is no comment', () => {
        const line = '    values: list[vec3] = {';
        const r = scanLineBraces(line, { inString: false }, () => {});
        expect(r.codeEnd).toBe(line.length);
    });

    it('ignores a # inside a string', () => {
        const line = '    name: string = "a#b"';
        const r = scanLineBraces(line, { inString: false }, () => {});
        expect(r.codeEnd).toBe(line.length);
    });

    it('still reports braces with their columns', () => {
        const seen: Array<[string, number]> = [];
        scanLineBraces('{ 1, 2, 3 }', { inString: false }, (ch, col) => seen.push([ch, col]));
        expect(seen).toEqual([['{', 0], ['}', 10]]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- blockExtraction`
Expected: FAIL — `scanLineBraces` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/editor/blockExtraction.ts`, export the interface and change the function. Replace the existing `interface BraceCursor` and `scanLineBraces` (lines 18-48) with:

```typescript
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
```

Then fix the two internal callers, which currently assign the result to a `BraceCursor`. In `matchClosingBrace` (~line 57) and `defaultBracketStack` (~line 245) the assignment `cursor = scanLineBraces(...)` still type-checks because the returned object structurally satisfies `BraceCursor`. No change needed — verify with tsc in Step 4.

- [ ] **Step 4: Run tests and type-check**

Run: `npm test -- blockExtraction`
Expected: PASS (all existing blockExtraction tests still pass).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/blockExtraction.ts src/lib/editor/blockExtraction.test.ts
git commit -m "refactor(bin-editor): export scanLineBraces and report where code ends"
```

---

### Task 2: Classify braces by line shape

The core grammar rule. A brace that is the last code on its line opens a **scope**; a brace that opens and closes within one line is a **value literal**.

**Files:**
- Create: `src/lib/editor/bracketCheck.ts`
- Create: `src/lib/editor/bracketCheck.test.ts`

**Interfaces:**
- Consumes: `scanLineBraces`, `BraceCursor` from Task 1.
- Produces:

```typescript
export interface BracketIssue {
    line: number;        // 1-based, where the issue is reported
    column: number;      // 1-based
    char: string;        // the brace character involved
    message: string;
    suggestLine: number; // 1-based line to insert the fix after
}
export interface BracketCheckResult {
    valid: boolean;
    errors: BracketIssue[];
}
export function checkRitobinBrackets(text: string): BracketCheckResult;
```

- [ ] **Step 1: Write the failing test**

Create `src/lib/editor/bracketCheck.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { checkRitobinBrackets } from './bracketCheck';

/** The shape from the bug report: inline vec3 literals inside a list scope. */
const VALID_DOC = [
    '#PROP_text',                                                  // 1
    'entries: map[hash,embed] = {',                                // 2
    '    "Foo" = VfxSystemDefinitionData {',                       // 3
    '        scale0: embed = ValueVector3 {',                      // 4
    '            dynamics: pointer = VfxAnimatedVector3fVariableData {', // 5
    '                times: list[f32] = {',                        // 6
    '                    0',                                       // 7
    '                    0.2',                                     // 8
    '                    1',                                       // 9
    '                }',                                           // 10
    '                values: list[vec3] = {',                      // 11
    '                    { 0.6250996, 0.2, 0.2 }',                 // 12
    '                    { 1, 1, 1 }',                             // 13
    '                    { 1.3, 1.3, 1.3 }',                       // 14
    '                }',                                           // 15
    '            }',                                               // 16
    '        }',                                                   // 17
    '    }',                                                       // 18
    '}',                                                           // 19
].join('\n');

describe('checkRitobinBrackets — valid input', () => {
    it('accepts a document with inline vec3 literals', () => {
        const r = checkRitobinBrackets(VALID_DOC);
        expect(r.errors).toEqual([]);
        expect(r.valid).toBe(true);
    });

    it('accepts empty containers written as {}', () => {
        const doc = [
            'entries: map[hash,embed] = {',
            '    "Foo" = TestClass {',
            '        empties: list[embed] = {}',
            '        nothing: option[string] = {}',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('accepts an rgba literal', () => {
        const doc = ['a: rgba = { 255, 128, 0, 255 }'].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('ignores braces inside strings and comments', () => {
        const doc = [
            'entries: map[hash,embed] = {',
            '    "Foo" = TestClass {',
            '        path: string = "a{b}c"',
            '        note: string = "unclosed {"',
            '        # a comment with }',
            '        rate: f32 = 1 // trailing }',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- bracketCheck`
Expected: FAIL — cannot resolve `./bracketCheck`.

- [ ] **Step 3: Implement**

Create `src/lib/editor/bracketCheck.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests and type-check**

Run: `npm test -- bracketCheck`
Expected: PASS (4 tests).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/bracketCheck.ts src/lib/editor/bracketCheck.test.ts
git commit -m "feat(bin-editor): classify ritobin braces by line shape"
```

---

### Task 3: Report the innermost unclosed block at its own header

Verifies the headline fix: the error lands on the block header, not at EOF.

**Files:**
- Modify: `src/lib/editor/bracketCheck.test.ts`

**Interfaces:**
- Consumes: `checkRitobinBrackets` from Task 2. No API change.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/editor/bracketCheck.test.ts`:

```typescript
describe('checkRitobinBrackets — unclosed blocks', () => {
    /* Line 5 opens VfxAnimatedVector3fVariableData and its closer was deleted. */
    const MISSING_CLOSER = [
        'entries: map[hash,embed] = {',                                // 1
        '    "Foo" = VfxSystemDefinitionData {',                       // 2
        '        scale0: embed = ValueVector3 {',                      // 3
        '            rate: f32 = 1',                                   // 4
        '            dynamics: pointer = VfxAnimatedVector3fVariableData {', // 5
        '                times: list[f32] = {',                        // 6
        '                    0',                                       // 7
        '                }',                                           // 8
        '        }',                                                   // 9
        '    }',                                                       // 10
        '}',                                                           // 11
    ].join('\n');

    it('reports the innermost block at its own header line, not at EOF', () => {
        const r = checkRitobinBrackets(MISSING_CLOSER);
        expect(r.valid).toBe(false);
        expect(r.errors[0].line).toBe(5);
        expect(r.errors[0].message).toContain('VfxAnimatedVector3fVariableData');
        expect(r.errors[0].message).toContain('never closed');
    });

    it('suggests inserting the closer at the end of the block, not the file', () => {
        const r = checkRitobinBrackets(MISSING_CLOSER);
        expect(r.errors[0].suggestLine).toBe(8);
    });

    it('names the innermost block when several are open', () => {
        const doc = [
            'a: embed = Outer {',   // 1
            '    b: embed = Inner {', // 2
            '        rate: f32 = 1',  // 3
        ].join('\n');
        const r = checkRitobinBrackets(doc);
        expect(r.errors[0].line).toBe(1);
        expect(r.errors.some(e => e.message.includes('Inner'))).toBe(true);
        expect(r.errors.some(e => e.message.includes('Outer'))).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- bracketCheck`
Expected: the first two FAIL. Without recovery, the closers on lines 9/10/11 pop the wrong frames, so the reported line is not 5. The third ("names the innermost block") passes already.

- [ ] **Step 3: Implement recovery**

Recovery is what makes the first two pass, so it is implemented HERE rather than in a later task — a task must never end with committed failing tests.

Two edits to `src/lib/editor/bracketCheck.ts`.

**3a.** Add this helper next to `isBlankOrComment`:

```typescript
/**
 * True when the line's code is nothing but closing brackets. Such a line sits at the PARENT's
 * indent, so it would otherwise look like an indent drop and trigger recovery on the very frame
 * its closer is about to pop — reporting an error for a perfectly valid `}`.
 */
function isOnlyClosers(code: string): boolean {
    const t = code.trim();
    return t.length > 0 && /^[}\])\s]+$/.test(t);
}
```

**3b.** Inside `checkRitobinBrackets`, insert the recovery block AFTER `const code = ...` and BEFORE the `for (let b = 0; ...)` brace-processing loop. The line has already been scanned at that point, so `code` is available and the line is not scanned twice.

```typescript
        /*
        Resynchronise on indentation. A non-blank line whose indent falls to or below an open
        frame's header indent means that frame's closer is missing: report it and pop, so the
        break stays local to its block instead of cascading through everything after it.
        Only `{` scopes opened on an EARLIER line are eligible — `[` and `(` never span lines in
        ritobin, so indentation says nothing about them.
        */
        if (!isBlankOrComment(line) && !isOnlyClosers(code)) {
            const ind = indentWidth(line);
            while (stack.length > 0) {
                const top = stack[stack.length - 1];
                if (top.char !== '{' || top.line >= lineNo || ind > top.indent) break;
                errors.push(unclosedIssue(top, lines));
                stack.pop();
            }
        }
```

Resulting order inside the per-line loop body:

1. brace scan → `scan`, `cursor`, `code`
2. recovery block (3b)
3. brace-processing loop

- [ ] **Step 4: Add the multi-break recovery test**

Append to `src/lib/editor/bracketCheck.test.ts`:

```typescript
describe('checkRitobinBrackets — recovery', () => {
    it('reports two separately broken blocks, not just the first', () => {
        const doc = [
            'entries: map[hash,embed] = {',    // 1
            '    "A" = TestClass {',           // 2
            '        inner: embed = Alpha {',  // 3  <- closer deleted
            '            rate: f32 = 1',       // 4
            '    }',                           // 5
            '    "B" = TestClass {',           // 6
            '        inner: embed = Beta {',   // 7  <- closer deleted
            '            rate: f32 = 2',       // 8
            '    }',                           // 9
            '}',                               // 10
        ].join('\n');
        const r = checkRitobinBrackets(doc);
        expect(r.errors.some(e => e.message.includes('Alpha'))).toBe(true);
        expect(r.errors.some(e => e.message.includes('Beta'))).toBe(true);
    });
});
```

- [ ] **Step 5: Run tests and type-check**

Run: `npm test -- bracketCheck`
Expected: PASS — all tests, including the two that were red in Step 2.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor/bracketCheck.ts src/lib/editor/bracketCheck.test.ts
git commit -m "feat(bin-editor): report the innermost broken block and recover on indent drops"
```

---

### Task 4: Surplus closers, including the leftover-after-deletion case

**Files:**
- Modify: `src/lib/editor/bracketCheck.test.ts`

**Interfaces:**
- Consumes: `checkRitobinBrackets`. No API change.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/editor/bracketCheck.test.ts`:

```typescript
describe('checkRitobinBrackets — surplus closers', () => {
    it('reports a leftover closer when the count goes negative', () => {
        const doc = [
            'entries: map[hash,embed] = {', // 1
            '    "Foo" = TestClass {',      // 2
            '        rate: f32 = 1',        // 3
            '    }',                        // 4
            '}',                            // 5
            '}',                            // 6  <- leftover from a deleted block
        ].join('\n');
        const r = checkRitobinBrackets(doc);
        expect(r.valid).toBe(false);
        expect(r.errors[0].line).toBe(6);
        expect(r.errors[0].char).toBe('}');
        expect(r.errors[0].message).toContain('no open block');
    });

    it('reports mismatched closer kinds', () => {
        const doc = [
            'a: embed = TestClass {', // 1
            '    rate: f32 = 1',      // 2
            ']',                      // 3
        ].join('\n');
        const r = checkRitobinBrackets(doc);
        expect(r.valid).toBe(false);
        expect(r.errors.some(e => e.line === 3 && e.char === ']')).toBe(true);
    });

    it('does not flag odd but valid indentation', () => {
        const doc = [
            'entries: map[hash,embed] = {',
            '  "Foo" = TestClass {',
            '            rate: f32 = 1',
            '        }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- bracketCheck -t "surplus"`
Expected: PASS for all three — Task 2's implementation already handles these. If any fail, fix `checkRitobinBrackets` before continuing.

This task is a guard: it proves surplus-closer detection works and that the no-false-positive rule holds for odd indentation.

- [ ] **Step 3: Commit**

```bash
git add src/lib/editor/bracketCheck.test.ts
git commit -m "test(bin-editor): cover surplus closers and odd-but-valid indentation"
```

---

### Task 5: Mtx44 — the one multi-line value brace

`push_value` emits mtx44 as one brace holding 16 bare floats, four per line. `read_mtx44` also tolerates a legacy per-row `{...}` form. Both must pass.

**Files:**
- Modify: `src/lib/editor/bracketCheck.ts`
- Modify: `src/lib/editor/bracketCheck.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/editor/bracketCheck.test.ts`:

```typescript
describe('checkRitobinBrackets — mtx44', () => {
    it('accepts the flat form rs_bin writes', () => {
        const doc = [
            'a: embed = TestClass {',
            '    Transform: mtx44 = {',
            '        1, 0, 0, 0',
            '        0, 1, 0, 0',
            '        0, 0, 1, 0',
            '        0, 0, 0, 1',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('accepts the legacy per-row form rs_bin tolerates', () => {
        const doc = [
            'a: embed = TestClass {',
            '    Transform: mtx44 = {',
            '        { 1, 0, 0, 0 }',
            '        { 0, 1, 0, 0 }',
            '        { 0, 0, 1, 0 }',
            '        { 0, 0, 0, 1 }',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npm test -- bracketCheck -t "mtx44"`
Expected: both PASS already — the flat form's `{` is a normal scope closed by `    }`, and the per-row rows are inline value literals. Recovery does not fire because the rows are indented deeper than the `Transform:` header.

If either fails, implement the exception: record the frame opened by a line matching `/:\s*mtx44\s*=\s*\{\s*$/` with a `isMtx44: true` flag and skip recovery for it.

- [ ] **Step 3: Commit**

```bash
git add src/lib/editor/bracketCheck.test.ts
git commit -m "test(bin-editor): cover both mtx44 text forms"
```

---

### Task 6: Wire BinEditor to the new checker

Replace the three local helpers. Four validation call sites plus two consumers that use `BRACKET_PAIRS` / `getBracketStackAtLine` for non-validation features.

**Files:**
- Modify: `src/components/preview/BinEditor.tsx` — delete lines 63-208 (the `Bracket Validation` section: `BracketError`, `BracketValidation`, `BRACKET_PAIRS`, `CLOSING_BRACKETS`, `OPEN_FOR_CLOSE`, `getBracketStackAtLine`, `validateBrackets`); update call sites at 754, 802, 848, 864, 961-965, 985, 1151, 1253.

**Interfaces:**
- Consumes: `checkRitobinBrackets`, `BracketCheckResult`, `BracketIssue` from Task 2; `scanLineBraces` from Task 1; `defaultBracketStack` behaviour is already provided by `computeInsertPosition`'s helper in `blockExtraction.ts`.

- [ ] **Step 1: Export the stack helper the inline-completion provider needs**

`getBracketStackAtLine` (BinEditor:85) duplicates `defaultBracketStack` (blockExtraction.ts:234). Export the latter under a clear name. In `src/lib/editor/blockExtraction.ts`, change:

```typescript
function defaultBracketStack(
```

to:

```typescript
export function bracketStackAtLine(
```

and update its two references inside that file (`computeInsertPosition`'s default parameter at ~line 215, and the function definition). Keep the existing behaviour and signature otherwise.

- [ ] **Step 2: Run existing tests to confirm nothing broke**

Run: `npm test -- blockExtraction`
Expected: PASS.

- [ ] **Step 3: Update BinEditor imports and delete the local helpers**

In `src/components/preview/BinEditor.tsx`, add to the existing `blockExtraction` import (or create one if absent):

```typescript
import { bracketStackAtLine } from '../../lib/editor/blockExtraction';
import { checkRitobinBrackets, type BracketCheckResult } from '../../lib/editor/bracketCheck';
```

Delete lines 63-208 entirely (the whole `// Bracket Validation` banner section through the end of `validateBrackets`).

Add a module-level constant for the closer lookup that the fix-button and label still need:

```typescript
const CLOSER_FOR: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
```

- [ ] **Step 4: Update the call sites**

- Line 754: `useState<BracketValidation>` → `useState<BracketCheckResult>`
- Lines 802, 848, 864, 985: `validateBrackets(` → `checkRitobinBrackets(`
- Line 961: `getBracketStackAtLine(fullText, position.lineNumber)` → `bracketStackAtLine(fullText, position.lineNumber)`
- Lines 964, 1151: `BRACKET_PAIRS[...]` → `CLOSER_FOR[...]`

- [ ] **Step 5: Fix the status label for surplus closers**

Line 1253 hardcodes `Missing '<closer>'`, which is wrong for a surplus closer (nothing is missing). Replace the `bracketLabel` body's single-error branch:

```typescript
        if (count === 1) return `Missing '${BRACKET_PAIRS[err.char] ?? err.char}' — ${suffix}`;
```

with:

```typescript
        if (count === 1) {
            // A surplus closer reports AT the offending line; an unclosed block reports at its
            // header and points forward, so suggestLine differs from line.
            if (err.suggestLine === err.line) return `Unexpected '${err.char}' — line ${err.line}`;
            return `Missing '${CLOSER_FOR[err.char] ?? err.char}' — ${suffix}`;
        }
```

- [ ] **Step 6: Type-check and test**

Run: `npx tsc --noEmit`
Expected: no errors. If tsc reports unused `CLOSING_BRACKETS`/`OPEN_FOR_CLOSE`, they were missed in the Step 3 deletion — remove them.

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 7: Commit**

```bash
git add src/components/preview/BinEditor.tsx src/lib/editor/blockExtraction.ts
git commit -m "feat(bin-editor): report the broken ritobin block instead of counting braces"
```

---

### Task 7: Verify in the running app

Automated tests cover the logic; this confirms the editor surface behaves.

**Files:** none modified unless a defect is found.

- [ ] **Step 1: Start the app**

Run: `npm run tauri dev`

Do NOT run `cargo build` or `cargo check` — the dev server compiles Rust itself.

- [ ] **Step 2: Open a VFX BIN and delete one closing brace**

Open any project BIN with nested `VfxSystemDefinitionData` / emitter blocks. Delete a single `}` from an inner emitter.

Expected: the error marker and status label point at that emitter's **header line**, naming the class — not at the last line of the file.

- [ ] **Step 3: Confirm the inline case is clean**

Find a `values: list[vec3] = {` block containing `{ 0.6250996, 0.2, 0.2 }` rows. With the file otherwise valid, the status bar shows no bracket error.

- [ ] **Step 4: Confirm the leftover-closer case**

Delete a whole emitter block but leave its trailing `}`.

Expected: the error points at the stray `}` and the label reads `Unexpected '}'`, not `Missing '}'`.

- [ ] **Step 5: Confirm the fix button and save gate**

With one unclosed block, click the fix affordance — the closer is inserted at the end of that block. Then confirm a clean file saves normally (Ctrl+S) and a broken one is refused with the toast pointing at the right line.

- [ ] **Step 6: Commit any fixes**

If a defect is found, fix it, add a regression test to `bracketCheck.test.ts`, and commit:

```bash
git add -A
git commit -m "fix(bin-editor): <what was wrong>"
```

---

## Self-Review

**Spec coverage:**
- Brace classification by line shape → Task 2
- Innermost block reported at its own header → Task 3
- Recovery on indent drops → Task 3
- Surplus closers incl. leftover-after-deletion → Task 4
- `suggestLine` preserved for `handleFixBracket` → Task 2 (`blockEndLine`), verified Task 7 Step 5
- Mtx44 both forms → Task 5
- Scanner consolidation (three copies → one) → Tasks 1, 6
- No-false-positive guards → Task 2 (valid docs), Task 4 (odd indentation)
- Save gate kept as-is → Task 6 leaves `handleSave` untouched; verified Task 7 Step 5

**Known deviation from the spec:** the spec's file table lists only `bracketCheck.ts`, its test, `blockExtraction.ts` and `BinEditor.tsx`. Task 6 additionally renames `defaultBracketStack` → `bracketStackAtLine` and exports it, because `getBracketStackAtLine` turned out to have a second consumer (the inline-completion provider at BinEditor:961) that the spec did not account for. This is a rename plus export, no behaviour change.

**Type consistency:** `BracketIssue` / `BracketCheckResult` are used consistently in Tasks 2-6. `checkRitobinBrackets` is the only entry point. `CLOSER_FOR` is defined in both `bracketCheck.ts` (module-private) and `BinEditor.tsx` (for the label and fix button) — intentional, as the editor needs it without importing internals.
