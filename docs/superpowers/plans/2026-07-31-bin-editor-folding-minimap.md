# BIN Editor Folding + Minimap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable code folding (always on) and a toggleable, size-capped minimap in Flint's BIN editor, matching Jade.

**Architecture:** Three changes. (1) Flip `folding: false` → `true` and add `foldingStrategy`/`showFoldingControls` in `EDITOR_OPTIONS`, which also revives the existing but dead Fold-all/Unfold-all emitter buttons. (2) Add a persisted `binEditorMinimap` preference to `uxStore`. (3) Add a toolbar toggle plus a `useEffect` that pushes the minimap setting to the live editor via `ed.updateOptions()`.

**Tech Stack:** React 18 + TypeScript, Monaco (`monaco-editor`, used via `monaco.editor.create` directly — NOT the `@monaco-editor/react` wrapper), Zustand.

## Global Constraints

- **No AI attribution anywhere.** No `Co-Authored-By` trailers, no "Generated with…" lines, no AI/Claude/assistant mentions in commits, code, or comments. Never sign commits.
- **Commit style (Flint):** Conventional Commits — `feat:` / `fix:` / `refactor:`. Optional scope, e.g. `feat(bin-editor): …`.
- **Commit after every completed task.** Never leave work uncommitted.
- **Never complicate things.** Simplest working solution; no speculative abstractions.
- **NEVER run `cargo build` or `cargo check`** in this repo — it wipes the Tauri incremental cache. This plan is frontend-only; `npx tsc --noEmit` is the verification command and is safe.
- **Minimap line cap:** `MINIMAP_MAX_LINES = 30_000` (exact value).
- Spec: `docs/superpowers/specs/2026-07-31-bin-editor-folding-minimap-design.md`

---

### Task 1: Enable folding in the BIN editor

Flipping the flag is the whole fix — Flint's ritobin language config already declares `brackets`, so Monaco's `auto` strategy derives `{ }` fold ranges by itself. This also makes the pre-existing `setEmittersFolded` helper (and its two toolbar buttons) work, because it reads fold regions that Monaco previously never computed.

**Files:**
- Modify: `src/components/preview/BinEditor.tsx:301` (inside `EDITOR_OPTIONS`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing new — `EDITOR_OPTIONS` keeps its type `editor.IStandaloneEditorConstructionOptions`.

- [ ] **Step 1: Replace the `folding: false` line**

In `EDITOR_OPTIONS`, find this exact line (line 301, directly after `minimap: { enabled: false },`):

```ts
    folding: false,
```

Replace it with:

```ts
    // Folding is bracket-derived: the ritobin language config declares
    // `brackets`, so Monaco's `auto` strategy builds `{ }` ranges with no
    // custom range provider. This also powers the Fold-all/Unfold-all emitter
    // buttons — `setEmittersFolded` reads regions off the folding
    // contribution, which computes nothing while folding is disabled.
    folding: true,
    foldingStrategy: 'auto',
    // Default is 'mouseover', which hides the gutter arrows until hover and
    // reads as "folding still doesn't work".
    showFoldingControls: 'always',
```

Leave `minimap: { enabled: false },` on the line above untouched — Task 3 handles it.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```bash
git add src/components/preview/BinEditor.tsx
git commit -m "fix(bin-editor): enable code folding

folding was hardcoded false, so Monaco computed no fold regions — the gutter
arrows were absent and the existing Fold-all/Unfold-all emitter buttons
silently did nothing, because setEmittersFolded reads regions off the folding
contribution. The ritobin language config already declares brackets, so the
auto strategy derives the ranges with no custom provider."
```

---

### Task 2: Add the persisted `binEditorMinimap` preference

**Files:**
- Modify: `src/lib/stores/uxStore.ts` (interface `UxPrefs`, `DEFAULTS`, interface `UxState`, `persist()`, store body)

**Interfaces:**
- Consumes: nothing.
- Produces: `useUxStore` gains field `binEditorMinimap: boolean` (default `true`) and action `setBinEditorMinimap: (on: boolean) => void`. Task 3 consumes both.

- [ ] **Step 1: Add the field to `UxPrefs`**

In `src/lib/stores/uxStore.ts`, in the `UxPrefs` interface, add after the `unknownPreviewByExt` field (the last member, ending line 21):

```ts
    /** Show Monaco's minimap in the BIN editor. Force-disabled above
     *  MINIMAP_MAX_LINES regardless of this preference. */
    binEditorMinimap: boolean;
```

- [ ] **Step 2: Add the default**

In the `DEFAULTS` object, add after `unknownPreviewByExt: {},`:

```ts
    binEditorMinimap: true,
```

- [ ] **Step 3: Add the action to `UxState`**

In the `UxState` interface, add after the `setUnknownPreviewForExt` line:

```ts
    setBinEditorMinimap: (on: boolean) => void;
```

- [ ] **Step 4: Persist the new field**

In `persist()`, the destructuring and the `writeStorage` call must both include the new key. Replace the two lines:

```ts
        const { glassmorphism, fpsMode, buttonGlow, accentPrimary, accentSecondary, glassBlur, glassOpacity, unknownPreviewByExt } = get();
        writeStorage({ glassmorphism, fpsMode, buttonGlow, accentPrimary, accentSecondary, glassBlur, glassOpacity, unknownPreviewByExt });
```

with:

```ts
        const { glassmorphism, fpsMode, buttonGlow, accentPrimary, accentSecondary, glassBlur, glassOpacity, unknownPreviewByExt, binEditorMinimap } = get();
        writeStorage({ glassmorphism, fpsMode, buttonGlow, accentPrimary, accentSecondary, glassBlur, glassOpacity, unknownPreviewByExt, binEditorMinimap });
```

(Omitting it here would make the toggle forget across reloads — `writeStorage` takes a full `UxPrefs`.)

- [ ] **Step 5: Add the setter**

In the returned store object, add after the `setUnknownPreviewForExt` block (before `reset:`):

```ts
        setBinEditorMinimap: (on) => { set({ binEditorMinimap: on }); persist(); },
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0. (A missing key in the `persist()` destructuring surfaces here as a `writeStorage` argument type error.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/stores/uxStore.ts
git commit -m "feat(ux-store): add persisted binEditorMinimap preference"
```

---

### Task 3: Wire the minimap toggle into the editor and toolbar

The editor is built with `monaco.editor.create` inside a `useEffect` that must NOT re-run on a preference change (recreating it would destroy the model and undo stack). So the initial value goes into the `create` call, and later changes are pushed with `ed.updateOptions()` from a separate effect.

**Files:**
- Modify: `src/components/preview/BinEditor.tsx` — import, `MINIMAP_MAX_LINES` const, component state, editor-create call (~line 979), new effect, toolbar button (~line 1420)

**Interfaces:**
- Consumes: `useUxStore` fields `binEditorMinimap: boolean` and `setBinEditorMinimap: (on: boolean) => void` from Task 2; the existing component state `lineCount: number` (declared line 829, kept current by the model-change handlers) and `editorRef: React.RefObject<editor.IStandaloneCodeEditor | null>`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Import the store**

At the top of `src/components/preview/BinEditor.tsx`, after the existing stores import on line 4:

```ts
import { useAppMetadataStore, useFileEditorStore, useNotificationStore } from '../../lib/stores';
```

add:

```ts
import { useUxStore } from '../../lib/stores/uxStore';
```

- [ ] **Step 2: Add the threshold constant**

Directly above `const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {` (line 293), add:

```ts
/** Monaco renders the WHOLE document into the minimap canvas, which is what
 *  degrades on very large VFX bins — so the minimap is force-disabled above
 *  this many lines regardless of the user preference. Folding is NOT capped:
 *  bracket-range computation is cheap. */
const MINIMAP_MAX_LINES = 30_000;
```

- [ ] **Step 3: Read the preference in the component**

In the `BinEditor` component, next to the existing `const [lineCount, setLineCount] = useState(0);` (line 829), add:

```ts
    const minimapPref = useUxStore((s) => s.binEditorMinimap);
    const setMinimapPref = useUxStore((s) => s.setBinEditorMinimap);
    // Above the cap the preference is overridden, and the toggle is disabled.
    const minimapAllowed = lineCount <= MINIMAP_MAX_LINES;
    const minimapOn = minimapPref && minimapAllowed;
```

- [ ] **Step 4: Seed the initial value at editor creation**

In the `monaco.editor.create` call (~line 979), add a `minimap` override AFTER the `...EDITOR_OPTIONS` spread so it wins:

```ts
        const ed = monaco.editor.create(editorContainerRef.current, {
            ...EDITOR_OPTIONS,
            minimap: { enabled: minimapOn },
            value: content,
            language: RITOBIN_LANGUAGE_ID,
            theme: RITOBIN_THEME_ID,
        });
```

Do NOT add `minimapOn` to this effect's dependency array — that would recreate the editor on every toggle and lose the undo stack. Step 5 handles updates.

- [ ] **Step 5: Push later changes to the live editor**

Add this effect immediately after the editor-creation `useEffect` closes (after its `}, [...])` line):

```ts
    // Apply minimap changes in place. The editor-creation effect must not
    // depend on the preference — re-running it would dispose the model and
    // the undo stack — so toggling is pushed through updateOptions instead.
    useEffect(() => {
        editorRef.current?.updateOptions({ minimap: { enabled: minimapOn } });
    }, [minimapOn]);
```

- [ ] **Step 6: Add the toolbar toggle**

In `bin-editor__toolbar-actions`, directly after the palette (`▤`) button's closing `</button>` (~line 1427) and before the `⚙` side-panel button, add:

```tsx
                    <button
                        className={`btn btn--sm${minimapOn ? ' btn--primary' : ''}`}
                        style={!minimapOn ? { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' } : undefined}
                        onClick={() => setMinimapPref(!minimapPref)}
                        disabled={!minimapAllowed}
                        title={minimapAllowed
                            ? 'Toggle minimap (document overview bar on the right)'
                            : `Minimap is disabled above ${MINIMAP_MAX_LINES.toLocaleString()} lines for performance`}
                    >
                        ▭
                    </button>
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0, no output.

- [ ] **Step 8: Commit**

```bash
git add src/components/preview/BinEditor.tsx
git commit -m "feat(bin-editor): add toggleable minimap

Persisted via uxStore and applied through updateOptions so toggling never
recreates the editor. Force-disabled above 30k lines, where Monaco's
whole-document minimap render is the part that degrades."
```

---

### Task 4: Verify in the running app

These are Monaco display options with no extractable logic — a unit test would only assert an object literal, so verification is manual per the spec.

**Files:** none modified (unless a defect is found).

**Interfaces:**
- Consumes: the finished behavior from Tasks 1–3.
- Produces: nothing.

- [ ] **Step 1: Start the app**

Run: `npm run tauri dev`

This compiles Rust itself — do NOT run `cargo build`/`cargo check` alongside it.

- [ ] **Step 2: Walk the spec's five checks**

Open any `.bin` file in the BIN editor and confirm:

1. A `VfxEmitterDefinitionData` block folds and unfolds via the gutter arrow, and the arrows are visible without hovering.
2. The "Fold all" / "Unfold all" emitter buttons (in the BIN tools side panel, `⚙`) collapse and expand emitter blocks.
3. The `▭` toolbar button shows and hides the right-hand minimap.
4. Toggle the minimap off, fully restart the app — it is still off.
5. Open a BIN over 30,000 lines (the toolbar shows the live line count): the minimap is absent and the `▭` button is disabled, with a title naming the cap.

- [ ] **Step 3: Report**

If all five pass, report done and note that no code changed in this task. If any fails, report exactly which check and the observed behavior rather than patching blindly.

---

## Self-Review

**Spec coverage:**
- Folding always on, `foldingStrategy: 'auto'`, `showFoldingControls: 'always'` → Task 1.
- Revives existing emitter fold buttons with no change to `setEmittersFolded` → Task 1 (verified Task 4 check 2).
- `binEditorMinimap` pref in `uxStore`, default true, existing `persist()` path → Task 2.
- `minimap.enabled = pref && lineCount <= 30_000`, reusing existing `lineCount` → Task 3 steps 3–5.
- Single `▭` toolbar toggle matching palette/gear idiom, disabled + explanatory title at the cap → Task 3 step 6.
- Live apply with no remount → Task 3 step 5 (`updateOptions`).
- Scope limited to BinEditor → no other file is touched.
- Manual verification, no unit tests → Task 4.

**Placeholder scan:** none — every step has literal code or an exact command.

**Type consistency:** `binEditorMinimap` / `setBinEditorMinimap` are named identically in Tasks 2 and 3. `MINIMAP_MAX_LINES` is defined in Task 3 step 2 and used in steps 3 and 6. `minimapPref` / `minimapAllowed` / `minimapOn` are defined once in step 3 and used consistently in steps 4, 5, and 6.
