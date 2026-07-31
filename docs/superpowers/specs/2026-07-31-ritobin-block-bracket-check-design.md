# Block-aware bracket checking for ritobin

## Problem

The BIN editor's bracket check reports failures at the wrong place, and misses failures
entirely in inline constructs.

`validateBrackets` in `src/components/preview/BinEditor.tsx` pushes every `{`, `[` and `(`
onto a single flat stack and pops on every closer. It has no model of what a ritobin block
is, which produces two user-visible defects:

**Errors surface at the end of the file.** An unclosed `{` is only discovered once the scan
finishes, in the drain loop over the leftover stack. Every closer after the break silently
pops the wrong frame, so the reported line is the last structure in the file rather than the
block that was actually edited.

**Inline value braces are treated as scopes.** ritobin writes `vec2`/`vec3`/`vec4`/`rgba` as
single-line literals (`{ 0.6250996, 0.2, 0.2 }`) and containers as multi-line scopes
(`values: list[vec3] = {`). Both are `{`. A flat counter cannot tell them apart, so it can
never report "this block is malformed" — only that the file's total count is off.

A leftover `}` from a deleted block is the same failure in reverse: the surplus closer pops a
legitimate outer scope, and the complaint lands far from the deletion. In the case where the
file still balances overall, the error is reported somewhere unrelated entirely.

Folding is unaffected by any of this because it is not the same code. There is no folding
range provider in the repo — `foldingStrategy: 'auto'` uses Monaco's own bracket engine,
driven by the `brackets` pairs declared in `ritobinLanguage.ts`. Folding working correctly is
therefore not evidence that `validateBrackets` should work; it is evidence that a separate,
better engine already runs beside it.

Brace scanning is currently implemented three times with subtly different behavior:
`scanLineBraces` (`blockExtraction.ts`), `getBracketStackAtLine` and `validateBrackets`
(both `BinEditor.tsx`).

## Constraints

**A false positive blocks saving.** `handleSave` refuses to save while `bracketStatus.valid`
is false. The gate is being kept, so the checker must never report an issue on text that
rs_bin would accept. Where the two could disagree, the checker stays silent and defers to
rs_bin, which reports `line N` on save and is already revealed in the editor.

**The UI contract is fixed.** The existing debounce, decorations, prev/next navigation, and
the `handleFixBracket` insert button stay as they are. The checker keeps returning
`{ valid, errors }` where each error carries `line`, `column`, `char`, `message` and
`suggestLine`.

## Grammar facts

Taken from `rs_bin`'s printer (`crates/rs_bin/src/text/print.rs`), which is the authority for
the text Flint reads and writes:

- `push_floats` emits `vec2`/`vec3`/`vec4` as `{ a, b, c }` on one line. `Rgba` likewise.
- `push_struct` emits `ClassName {` then a newline, or `ClassName {}` when it has no fields.
- Empty `List`, `Map` and `Option` emit `{}`.
- Non-empty `List`, `Map` and `Option` emit `{` then a newline.
- `Mtx44` is the sole multi-line value brace: one brace holding 16 bare floats, four per
  line, no per-row braces. `read_mtx44` additionally tolerates a legacy per-row `{...}` form.

So in any text rs_bin produced, **a brace's role is decidable from its line**, which is what
makes block-level checking possible without a parser.

## Design

### Brace classification

Each line is scanned once, string- and comment-aware. Every brace is classified before it is
matched:

| Shape | Example | Role |
|---|---|---|
| Opens, line then ends | `dynamics: pointer = VfxAnimatedVector3fVariableData {` | Scope |
| Opens and closes on the same line | `{ 0.6250996, 0.2, 0.2 }` | Value literal |
| Line contains only a closer | `}` | Close |

Value literals are verified as self-contained and then ignored by the block matcher. They
never touch the scope stack, so an inline `vec3` can no longer shift the depth count. `{}`
is a value literal by the same rule.

`mtx44` is the one exception. It is recognised by the `: mtx44 =` annotation on its opening
line and matched by scanning forward to its closer, accepting both the flat and legacy
per-row forms so the checker agrees with `read_mtx44`.

### Scope stack

Scope frames carry the header line, the class name where the line has one, the opening
column, and the header's indent width.

An unclosed scope is reported at **its own header line**, naming the block:

```
VfxAnimatedVector3fVariableData (opened line 12) is never closed
```

When several scopes are open at a failure, the **innermost** is reported. That is the block
that was actually edited.

### Recovery

Indentation is the resynchronisation signal. When a non-blank, non-comment line's indent
falls to or below an open scope's header indent without a closer having accounted for it,
that scope is closed by inference: an issue is recorded against its header and the frame is
popped. Scanning continues.

This keeps one missing `}` local to the block that lost it, instead of cascading through
every following emitter.

### Surplus closers

A closer with no scope to close is reported at its own line. Where a frame is available, the
message names what it appears to be wrongly closing, using indent only to phrase the message
and pick the location.

Indent disagreement is **never itself a trigger**. A closer is only flagged when there is
genuinely nothing to close, so a validly-structured file with unusual hand formatting stays
clean. This follows directly from the save-gate constraint.

### `suggestLine`

Preserved for `handleFixBracket`. For an unclosed scope it is the last line belonging to that
block, determined by the same indentation walk used for recovery — so the inserted closer
lands at the end of the block rather than at the end of the file. For a surplus closer it is
the closer's own line.

## Structure

- **`src/lib/editor/bracketCheck.ts`** (new) — the checker. Pure, no imports beyond the
  shared scanner. Exports the check function and its issue type.
- **`src/lib/editor/bracketCheck.test.ts`** (new) — unit tests, following
  `blockExtraction.test.ts`.
- **`src/lib/editor/blockExtraction.ts`** — `scanLineBraces` becomes the single shared brace
  scanner and is exported for the checker's use. It needs one additive change: it currently
  `break`s out of the line at `#` / `//`, which discards the rest-of-line context the checker
  needs to decide whether a brace ends its line. It gains a reported "code ends here" column
  so callers can distinguish "line ended" from "comment started" without a second scan. Its
  existing behavior for `findEnclosingBlock` and `defaultBracketStack` is unchanged.
- **`src/components/preview/BinEditor.tsx`** — `validateBrackets`, `getBracketStackAtLine`
  and the local `BRACKET_PAIRS` / `CLOSING_BRACKETS` / `OPEN_FOR_CLOSE` constants are
  deleted; the four call sites use the new module. `computeInsertPosition`'s
  `defaultBracketStack` dependency in `blockExtraction.ts` is unaffected.

Net effect on the three duplicate scanners: one implementation, used by all callers.

## Test cases

Structural:
- Unclosed block reports at its own header, not at EOF.
- Innermost of several open blocks is the one reported.
- Inline `vec3`/`vec2`/`vec4`/`rgba` literals never open a scope.
- `{}` empty containers never open a scope.
- `mtx44` flat form passes; legacy per-row form passes.
- Braces inside strings and after `#` / `//` comments are ignored.

Deletion damage:
- Leftover `}` after a deleted block, count negative — reported at the stray closer.
- Leftover `}` after a deleted block where the file still balances — reported, not silently
  absorbed.
- Two separately broken blocks are both reported, not just the first.

No-false-positive guards:
- A real unmodified VFX bin (the `scale0` / `VfxAnimatedVector3fVariableData` shape from the
  report) reports clean.
- A validly-structured file with irregular indentation reports clean.

## Rejected: integrating ritobin-lsp

`alanpq/ritobin-lsp` is a Rust language server for ritobin. Not adopted:

- Its documented "Diagnostics" feature is parser-driven, so without explicit error recovery
  it reports at the first failing token — the same report-at-the-wrong-place behavior this
  work exists to fix. It is not established that it would deliver block-level reporting.
- Integration cost is permanent: shipping and lifecycle-managing a sidecar binary in Tauri,
  JSON-RPC over stdio, `monaco-languageclient` and its version coupling, plus crash and
  restart handling.
- It is a third-party pin against a grammar RitoShark owns, so disagreements mean debugging
  an external parser.

If authoritative in-editor diagnostics are wanted later, exposing a check-only `rs_bin` entry
point is strictly better: same correctness, no sidecar, no protocol, no third-party pin. This
design does not foreclose that.

## Known tradeoff

The brace rules live in TypeScript while the grammar lives in Rust, so they can drift. The
rules are derived from `print.rs`'s emit shapes and that source is documented in the module.
The save gate limits the blast radius in one direction only — the checker is built to
under-report rather than over-report, leaving rs_bin as the authority on anything ambiguous.
