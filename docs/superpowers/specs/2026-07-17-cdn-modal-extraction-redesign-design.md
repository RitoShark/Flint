# CDN Modal + Extraction Browser Redesign

Date: 2026-07-17

Redesign the "Load from CDN" modal and the manifest extraction browser
(`ManifestBrowser`) to be modern, design-lab styled, and more usable.
Approved via interactive mockup.

## Screen 1 — Load from CDN modal (`src/components/modals/LoadManifestModal.tsx`)

- **No `×` close button** — Cancel is the only dismiss (ecosystem UX rule).
- **One-row selectors**: Platform · Kind · Region as three equal-width
  **dropdown-trigger** buttons (label + chevron) on a single flex row, each
  opening a design-lab dropdown menu with a checkmark on the current value.
  Region menu lists all 18 regions. This replaces the old two-row pill layout
  (saves vertical space).
- **Version header row**: `"N manifests"` count on the left; on the right an
  **icon-only Refresh** button immediately left of a **search input**
  ("Filter version / patch…"). Search filters the card list live (matches
  version or patch text) and updates the count to `"M of N manifests"`.
- **Version card list** (replaces the raw `<select size=12>`): each card shows
  the version (bold, tabular-nums), a `patch X · build Y` subline, a right-side
  **kind badge** (`● game` / `● client`, client badge uses the warning hue),
  and a green **Downloaded** pill when the manifest is cached on disk. Selected
  card gets the accent border/tint. Themed thin scrollbar with
  `scrollbar-gutter: stable` (fixes the current clipped-scrollbar bug).
- **States**:
  - *Fetching versions* → a spinner overlay over the list area
    ("Fetching version history…").
  - *Loading manifest* (after Load) → the Load button becomes a spinner
    ("Loading manifest…") before the browser view mounts.
  - Errors → inline `.dl-badge--danger` (unchanged).
- **Modal open animation**: existing `dl-modal-in` scale/fade
  (`prefers-reduced-motion` respected).

### Downloaded badge — backend support

`load_manifest_from_url` already writes each manifest to
`%APPDATA%\Flint\manifest\<url-basename>`. New command
**`cdn_cached_versions(region, platform) → Vec<String>`** returns the catalog
`path`s whose manifest file is already present on disk. It resolves each
catalog entry's URL **cache-only** (no network — a `resolve_manifest_url_cached`
variant that returns `None` on a cache miss instead of fetching), derives the
manifest filename, and checks existence. Frontend renders ⬇ when
`cachedSet.has(entry.path)`. Called on open and on region/platform/version
change.

## Screen 2 — Extraction browser (`src/components/browser/ManifestBrowser.tsx`)

- **Checkboxes** on every folder / WAD / file row. Parent checks **cascade** to
  descendants; a parent with a partial descendant selection shows a **tri-state
  partial** mark. Drives the store's existing (currently unused) `checkedFiles`
  set — keyed by manifest `file_index` (and inner-WAD entries where applicable;
  MVP scope: manifest-level file indices — inner-entry checkboxes are a
  follow-up if needed).
- **Bottom action bar**: running `"N files · X MB selected"` summary + a
  **Clear** ghost button + a primary **Extract selected…** button. During
  extraction the bar swaps to a **progress bar** + per-file status
  (`"54 / 128 · body.tex"`) + Cancel.
- **Hide other languages toggle** (design-lab switch in the toolbar, **ON by
  default**): hides WADs whose filename has a locale segment
  (`*.<locale>.wad.client`) EXCEPT the client's own default locale (en_US) and
  no-locale WADs. Locale detection: a WAD basename matching
  `/\.([a-z]{2}_[A-Z]{2})\.wad\.client$/`; keep if locale is absent or equals
  the default (`en_US`). Hidden WADs are filtered out of the visible tree AND
  excluded from cascade selection.
- **Search input** in the toolbar filters the manifest tree by path substring
  (keeps existing per-node behavior; additive).
- Per-node "Extract" buttons stay (quick single-target extract).
- Preview pane (right side) unchanged.

## Logging cleanup (batched, separate concern)

- `projects.json` corrupt warning: dedupe (log once, not 3×) and drop to
  `debug!` — benign, already ignored gracefully.
- `read_file_bytes` "File not found: thumbnail.webp": expected for projects
  without a thumbnail — the thumbnail read path treats not-found as a normal
  miss (debug/empty), not a `WARN`.
- The `IPC custom protocol failed … Failed to fetch` warning is Tauri core's own
  benign fallback on a network call; left as-is (not ours, call still succeeds).

## Non-goals / YAGNI

- No inner-WAD-entry-level checkboxes in v1 (manifest-level indices only).
- No per-locale picker (single "hide non-default locales" toggle).
- No new download/extraction engine — reuses `cdn_extract` +
  `cdn-extract-progress`.
