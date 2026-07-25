# Keyboard & Mouse Shortcuts — Design

**Date:** 2026-07-25
**Branch:** `feat/qol-improvements`
**Status:** Approved for implementation

## Goal

Make Flint driveable from the keyboard. Three surfaces get shortcuts — the tab bar, the
file tree / WAD Explorer, and the preview viewports — on top of a shortcut engine rebuilt
to make context-sensitive bindings possible at all.

## Scope

**In scope**

- Rebuild the shortcut engine as a declarative manifest + pure resolver.
- Tab bar keyboard navigation (cycle, jump-to-N, reopen-closed).
- File tree & WAD Explorer keyboard navigation (arrows, range-extend, type-to-find, copy path).
- Preview viewport bindings (frame camera, zoom presets) and consistent wheel/pan across viewers.
- A cheat-sheet overlay generated from the manifest.
- Migrate the seven hand-rolled keydown listeners onto the engine.

**Non-goals**

- Command palette / fuzzy quick-open. Explicitly deferred.
- User-remappable keys and any `configStore` schema change. Keys are fixed this round.
- Global (OS-level) Tauri shortcuts. Everything stays in the webview.
- Touch / gamepad input.

## Problem statement

The existing engine is `src/lib/util/utils.ts:154-184` — a `Map<combo, handler>` and one
`document` keydown listener. It has five defects that cap what can be added:

| # | Defect | Consequence |
|---|--------|-------------|
| 1 | No text-entry guard | Any unmodified single-key binding corrupts typing, incl. the Monaco bin editor |
| 2 | One handler per combo, globally | Two views can never bind the same key differently; `Map.set` overwrites silently |
| 3 | Modifier order is load-bearing | Combo built strictly `ctrl+shift+alt+key`; `'shift+ctrl+f'` registers and never fires |
| 4 | `Ctrl+Shift+<digit>` unreachable | Keys off `e.key`, which is `!` not `1` when Shift is held |
| 5 | Listener never removed | `[]`-dep effect + StrictMode double-mount ⇒ every handler fires twice in dev |

Defect 2 is why seven components hand-rolled their own listeners rather than using the
registry: `WadExplorer.tsx:488`, `FileTree.tsx:344`, `InibinEditor.tsx:129`,
`ThumbnailEditor.tsx:524`, `AudioCutterModal.tsx:598`, `BnkPreview.tsx:534`, plus ~20 modals
doing their own `Escape`/`Enter`. Those islands listen on `window` while the registry listens
on `document`, so both fire for one keystroke.

## Engine design

### Module layout

New `src/lib/shortcuts/`. The keyboard section of `utils.ts` is deleted; its formatting,
async, and file-icon sections stay put.

| File | Responsibility | Pure |
|------|----------------|------|
| `types.ts` | `ActionId`, `ScopeId`, `Shortcut`, `Combo` | — |
| `manifest.ts` | Every shortcut as data. Single source of truth for keys *and* labels. | data |
| `combo.ts` | `parseCombo`, `comboFromEvent`, `formatCombo` | yes |
| `resolve.ts` | `resolve(combo, scopeStack, manifest) → ActionId \| null` | yes |
| `tabOrder.ts` | `buildTabList(state) → TabRef[]`, `nextTab`, `tabAtIndex` | yes |
| `registry.ts` | action-id → handler map, scope stack, listener install/teardown | no |
| `hooks.ts` | `useScope(scopeId)`, `useAction(id, fn, deps)` | React |

Only `registry.ts` and `hooks.ts` touch the DOM or React. Vitest runs `environment: 'node'`
with `include: ['src/**/*.test.ts']`, so all tested logic must be DOM-free `.ts` — which is
exactly what the pure split delivers.

### Shortcut record

```ts
interface Shortcut {
  id: ActionId;              // 'tab.next', 'tree.moveDown', …
  keys: string;              // authored in any modifier order
  label: string;             // shown in the cheat sheet
  group: string;             // cheat-sheet section
  scope: ScopeId;
  allowInTextEntry?: boolean; // default false
  survivesModal?: boolean;    // default false
}
```

Keys and label live in the same record, so the cheat sheet cannot drift from the bindings.

### Combo normalization (fixes 3 and 4)

`parseCombo` **sorts** modifiers into canonical order rather than trusting authored order, so
`'shift+ctrl+f'` and `'ctrl+shift+f'` yield an identical `Combo`. Defect 3 is structurally gone.

Key identity is resolved per category, and the split is deliberate:

- **Letters → `e.key.toLowerCase()`** — layout-correct; a Dvorak user pressing the key
  labelled `F` gets `f`.
- **Digits → `e.code`** (`Digit0`…`Digit9`) — required, because `e.key` for `1` with Shift
  held is `!`. This is the fix for defect 4. Includes `Digit0`, used by `Ctrl+0`.
- **Named keys → `e.key`** — `Escape`, `Tab`, `ArrowUp/Down/Left/Right`, `Delete`, `Home`,
  `End`, `F1`, `F2`.
- **Punctuation → `e.key`** — keeps the existing `Ctrl+,` binding working unchanged.

Using `e.code` for letters would be wrong: it reports US-QWERTY physical position and so
mangles alternate layouts. Digits are the narrow exception where `e.key` is the broken one.

### Text-entry guard (fixes 1)

One predicate, promoted from `FileTree.tsx:339` — the only one of the three existing copies
that is correct, because it is the only one that also checks `.monaco-editor`:

```
isTextEntry(el) := INPUT | TEXTAREA | [contenteditable="true"]
                 | closest('.monaco-editor') | [role="textbox"]
```

It cannot be a blanket block: `Ctrl+S` and `Escape` must fire while the user types in the bin
editor. Shortcuts opt out individually with `allowInTextEntry: true`. Default is blocked.

### Scope stack (fixes 2)

```
  modal          ← pushed when activeModal !== null; MASKS everything below
  file-tree      ← focus scopes, pushed by useScope() on focus, popped on blur
  model-preview
  zoomable
  <view>         ← derived from navigationStore.currentView
  global         ← always present, bottom
```

`ScopeId = 'global' | 'welcome' | 'preview' | 'extract' | 'wad-explorer' | 'file-editor'
| 'archive-editor' | 'manifest' | 'file-tree' | 'model-preview' | 'zoomable' | 'modal'`

The first eight are view scopes derived from `currentView`; `file-tree`, `model-preview` and
`zoomable` are focus scopes; `modal` is state-derived and masking.

Resolution walks top→bottom, first match wins.

Two decisions:

1. **`modal` masks.** With a modal open, only `modal`-scoped shortcuts and entries flagged
   `survivesModal` resolve. This fixes a live bug: today `Ctrl+N` with the New Project modal
   open tries to open a second one.
2. **View scopes are derived, focus scopes are pushed.** `currentView` already exists and is
   authoritative, so view scope is computed and can never desync. Only the two focus scopes
   are manually pushed, and a view that forgot to pop would be the one leak class — narrow
   enough to audit.

### Install lifecycle (fixes 5)

`installShortcuts()` returns a teardown and keeps a module-level refcount, making it
idempotent under StrictMode's double-mount. `App.tsx` calls it from an effect that returns
the teardown, replacing the current fire-and-forget `initShortcuts()`.

### Action registration

`useAction(id, fn, deps)` writes into `Map<ActionId, Handler>`. The resolver has already
decided the scope, so the component owning that scope owns the handler. A duplicate live
registration for one id logs a dev warning.

## Tab order model

`TitleBar.tsx` renders six tab families. The visual order is the DOM order and the keyboard
order must match it exactly:

1. WAD Explorer pseudo-tab (`:572`, singleton, present when open)
2. File editor tabs (`:602`)
3. Project tabs (`:628`)
4. Extract sessions (`:637`)
5. CDN manifest sessions (`:646`)
6. Archive tabs (`:655`)

`buildTabList(state)` flattens these into `TabRef[]` where
`TabRef = { kind, id, label }`. It is pure and unit-tested. Activation is a separate impure
dispatcher that routes per `kind` to the existing store actions; closing already routes
through `navigationCoordinator`, which is left untouched.

Extract sessions whose id starts with `archive-` are ArchiveEditor-internal and are excluded
from the list, matching the existing filtering throughout `navigationCoordinator`.

**Reopen-closed** keeps a bounded stack (cap 10) of `{ kind, reopenPayload }` pushed by the
close paths. Only project tabs, extract sessions, file-editor tabs and archive tabs are
reopenable; the WAD Explorer singleton is not.

## Shortcut manifest

### Global

| Keys | Action | Notes |
|------|--------|-------|
| `Ctrl+N` | New project | existing; gains `modal` masking |
| `Ctrl+S` | Save project | existing; `allowInTextEntry` |
| `Ctrl+,` | Settings | existing |
| `Ctrl+E` | Export | existing |
| `Ctrl+W` | Close current | existing; view-aware logic unchanged |
| `Escape` | Close modal | existing; `allowInTextEntry` + `survivesModal` |
| `F1` | Toggle cheat sheet | new |

### Tabs — `global`

| Keys | Action |
|------|--------|
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+1`…`Ctrl+8` | Jump to tab N |
| `Ctrl+9` | Jump to last tab |
| `Ctrl+Shift+T` | Reopen last closed tab |

Cycling wraps. `Ctrl+Tab` must `preventDefault` so the webview never moves focus instead.

### File tree — `file-tree`

| Keys | Action |
|------|--------|
| `ArrowDown` / `ArrowUp` | Move focus |
| `ArrowRight` | Expand folder, else descend |
| `ArrowLeft` | Collapse folder, else ascend to parent |
| `Shift+ArrowDown` / `Shift+ArrowUp` | Extend selection from anchor |
| `Ctrl+A` | Select all visible rows |
| `Home` / `End` | First / last row |
| `Enter` | Open focused |
| `Ctrl+C` | Copy path(s) of selection |
| `F2` | Rename (existing, migrated) |
| `Delete` | Delete selection (existing, migrated) |
| printable char | Type-to-find, 600 ms buffer |

Type-to-find is **not** a manifest entry. It is a fallback in the `file-tree` scope handler,
consulted only after `resolve` returns `null` for the keystroke, so a declared binding always
wins over the search buffer.

Reuses `rows` (from `flattenTree`), `selectedPaths: Set<string>` and `anchorRef` — all already
present at `FileTree.tsx:314-325`. Ctrl/Shift **click** multi-select already works
(`:379-398`); keyboard range-extend shares the same anchor so the two models cannot disagree.

A `focusedPath` cursor plus a visible focus ring is added — keyboard scope is meaningless if
the user cannot see what is focused. The row list is virtualized, so moving focus must scroll
the focused row into view.

### WAD Explorer — `wad-explorer`

| Keys | Action |
|------|--------|
| `Ctrl+F` | Focus search (existing island, migrated) |
| `Escape` | Clear search when search focused (existing island, migrated) |

Arrow navigation for the WAD Explorer's own tree is deferred to a follow-up; this round only
migrates its island onto the engine so it appears in the cheat sheet.

### Preview viewports

Two scopes, because zoom is broader than the 3D preview:

| Keys | Action | Scope |
|------|--------|-------|
| `F` | Frame / re-frame the model | `model-preview` |
| `Ctrl+0` | Reset zoom to 100% | `zoomable` |
| `Ctrl+=` / `Ctrl+-` | Zoom in / out | `zoomable` |

`zoomable` is a focus scope pushed by any viewer that supports zoom — the 3D preview plus the
image/audio viewers listed under Mouse consistency. This avoids declaring the same three
bindings once per viewer, which would violate the one-record-per-shortcut rule the whole
design rests on.

`ModelPreview.tsx:837-848` already computes the framed pose and derives every control
constant from the model's bounding radius (`wheelPrecision = 80/radius`,
`panningSensibility = 8000/radius`, zoom clamped 0.02×–50×), then sets
`alpha = π/2 + π/8, beta = π/3`. That block is inline in the mesh-load effect and bound to
nothing. It is extracted to `frameCamera(camera, meshData)` and called from both the load
effect and the new binding — which also gives a recovery path for a model that loads with a
degenerate bounding box, currently unrecoverable for the session.

Orbit / wheel-zoom / pan continue to come from Babylon's `attachControl`; no reimplementation.

### Mouse consistency

Five viewers implement wheel-zoom with different step maths — `ChunkPreview.tsx:215`,
`FullResImageModal.tsx:89`, `RecolorModal.tsx:376`, `ThumbnailCropModal.tsx:205`,
`AudioCutterModal.tsx:447`. A shared `useWheelZoom({ min, max, step })` hook standardises
multiplicative stepping and clamping. Existing idioms are preserved as-is:

- middle-click closes a tab (`TitleBar.tsx`, four call sites)
- `Alt`+drag / middle-drag pans (`AudioCutterModal.tsx:357`)
- right-click opens the shared `ContextMenu`; native menu stays suppressed at
  `App.tsx:189-199`
- wheel resizes cards in `FolderGridView.tsx:77` — left alone, it is not a zoom

## Cheat sheet

`ShortcutCheatSheet.tsx` in `src/components/overlays/`, toggled by `F1`, rendered from
`manifest.ts` grouped by `group`. Combos render through `formatCombo` so display and binding
share one formatter. Named distinctly from the existing `WadCheatSheetModal`, which is about
WAD filenames, not keys.

Shortcut hints are added to tooltip and context-menu items by looking up `ActionId` in the
manifest — again one source, no hand-copied strings.

## Testing

Unit tests, `.test.ts`, node environment, no DOM:

- `combo.test.ts` — modifier-order independence; `ctrl+shift+1` resolves to a digit combo,
  not `!`; letters use `e.key`; `Ctrl+,` still parses.
- `resolve.test.ts` — first-match-wins ordering; `modal` masking; `survivesModal`;
  `allowInTextEntry`; `Ctrl+W` differs under `['global','wad-explorer']` vs
  `['global','preview','file-tree']`.
- `manifest.test.ts` — **no two shortcuts collide within a scope**; every `keys` string is
  parseable and reachable; every `id` is unique. This converts defects 3 and 4 from
  launch-and-press-it bugs into CI failures.
- `tabOrder.test.ts` — family ordering matches TitleBar DOM order; `archive-` sessions
  excluded; cycle wraps; `tabAtIndex` clamps; `Ctrl+9` picks last.

Manual verification: typing in the Monaco bin editor with the tree focused; `Ctrl+S` from
inside Monaco; `Ctrl+N` with a modal open; dev-mode single-fire under StrictMode.

## Rollout

Sequenced so each phase is independently verifiable:

1. Engine + tests, no behaviour change — migrate the six existing `App.tsx` shortcuts.
2. Migrate the seven island listeners onto the engine.
3. Tab navigation (`tabOrder.ts`, reopen stack, bindings).
4. File tree keyboard nav + focus ring + scroll-into-view.
5. Viewport — extract `frameCamera`, add bindings, `useWheelZoom`.
6. Cheat sheet + tooltip/context-menu hints.

Phase 1 lands the engine with existing behaviour intact, so a regression there is caught
before any new binding is added.

## Risks

- **`Ctrl+Tab` interception.** Webviews may treat it as focus traversal; needs
  `preventDefault` on `keydown` and verification in the built Tauri app, not just `vite dev`.
- **Virtualized tree scroll-into-view.** `react-window` needs an imperative
  `scrollToItem`; the focused index must be tracked outside the virtual window.
- **Monaco key interception.** Monaco swallows some combos before they bubble. `Ctrl+S` from
  inside the bin editor is the specific case to verify.
- **Scope leak on unmount.** Only the two focus scopes can leak; `useScope` must pop in its
  effect cleanup.
