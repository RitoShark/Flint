# BIN editor: code folding + minimap

## Problem

The BIN editor has no working code folding and no minimap, unlike Jade — even though both are the same Monaco.

`EDITOR_OPTIONS` in `src/components/preview/BinEditor.tsx` hardcodes:

```ts
minimap: { enabled: false },
folding: false,
```

Two consequences:

1. **No minimap** — the right-hand overview bar Jade shows is absent.
2. **Folding is dead, including the existing buttons.** The toolbar already has
   "Fold all / Unfold all VfxEmitterDefinitionData blocks" wired to
   `setEmittersFolded`, which reads `regions` off the folding contribution's
   model. With `folding: false` Monaco never computes fold regions, so
   `regions` is empty and the function returns without doing anything. The
   buttons look broken because the feature backing them is switched off.

## Root cause

Only the two option flags. No language work is required: Flint's ritobin config
already declares `brackets` (`src/lib/editor/ritobinLanguage.ts`), so Monaco's
`auto` folding strategy derives `{ }` fold ranges by itself — the same way
Jade's does. Jade's `ritobinLanguage.ts` defines no explicit folding markers
either; its folding comes from the identical bracket declaration plus
`folding: true`.

## Design

### Folding — always on

Static in `EDITOR_OPTIONS`:

```ts
folding: true,
foldingStrategy: 'auto',        // bracket-derived; no custom range provider
showFoldingControls: 'always',  // gutter arrows always visible, not hover-only
```

Not user-toggleable — there is no reason to want it off, and it is the feature
this change exists to fix. Enabling it makes the two existing emitter
fold/unfold buttons work with no change to `setEmittersFolded`.

`showFoldingControls: 'always'` is deliberate: Monaco's default (`'mouseover'`)
hides the arrows until hover, which reads as "folding still doesn't work".

### Minimap — toggleable, with a size cap

One persisted preference, `binEditorMinimap` (default `true`), added to
`uxStore` alongside `unknownPreviewByExt` and written through the existing
`persist()` / `writeStorage` path. No new persistence mechanism.

The minimap is enabled only when the preference is on **and** the document is
at most **30,000 lines**:

```ts
minimap: { enabled: binEditorMinimap && lineCount <= MINIMAP_MAX_LINES }
```

The cap exists because Monaco renders the entire document into the minimap
canvas, which is the part that degrades on very large VFX bins. Folding is not
capped — bracket-range computation is cheap.

`lineCount` is already tracked as component state and kept current on every
model change; the threshold reuses it rather than adding new tracking.

### UI

A single `▭` toggle button in `bin-editor__toolbar-actions`, beside the
existing palette (`▤`) and side-panel (`⚙`) toggles, following their exact
idiom: `btn btn--sm`, `btn--primary` when active, otherwise the
`var(--bg-tertiary)` + `1px solid var(--border)` inline style, plus a `title`.

When the 30k cap forces the minimap off, the button renders `disabled` with a
title naming the reason, so a toggle that cannot take effect is never a
mystery.

### Data flow

Click → `uxStore` setter → `persist()` → localStorage; the component re-reads
via selector → `useMemo` recomputes the options object → `<Editor options>`.
Monaco applies both settings live through `updateOptions`, so there is no
remount and the model, undo stack, and scroll position all survive.

## Scope

`BinEditor` only. Flint's other Monaco surfaces (`InibinEditor`,
`StringTableEditor`, `ReadOnlyMonaco`) would benefit too, but the request was
the BIN editor and widening the change risks unrelated regressions.

## Testing

These are Monaco display options with no extractable logic — a unit test would
only assert an object literal, so none is added. Verified by running the app:

1. A `VfxEmitterDefinitionData` block folds/unfolds via the gutter arrow.
2. "Fold all" / "Unfold all" emitter buttons collapse and expand blocks.
3. The minimap toggle shows and hides the right bar.
4. The setting survives an app reload.
5. On a BIN over 30k lines the minimap stays off and its button is disabled.
