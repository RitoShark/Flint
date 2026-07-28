# First-time Setup Wizard — settings expansion & shared settings CSS

Date: 2026-07-25
Status: Approved (design)

## Problem

Two independent issues, both about settings surfaces.

**1. The setup wizard collects far less than Settings offers.** A new user finishes
onboarding without ever seeing Jade/Quartz integration, file associations, auto-update,
their creator links, or the finer appearance controls. Those only exist in `SettingsModal`,
which a first-time user has no reason to open.

| Wizard step | Collects today | Present in Settings, missing from the wizard |
|---|---|---|
| Theme | preset grid, glass toggle | glass blur, glass opacity, FPS mode, button glow |
| Identity | creator name, description | creator home URL, tip link |
| Paths | project folder, League, PBE, launcher | Jade path, Quartz path, auto-sync to launcher |
| Finish | summary | file associations ("Open with"), automatic updates |

`detectAll()` in the wizard already calls `api.detectExternalApps()`, which returns
`jade` and `quartz` — and **throws both away**. The detection work is already being done.

**2. `settings-polish.css` cannot reach the wizard.** Almost every rule in it is scoped to
`.modal--settings`. The wizard renders under `.fwiz`, outside that modal, so none of it
applies. `flint-2.css` compensates by hand-duplicating the rules with the prefix swapped —
its own comment says so:

> `.modal--settings; the wizard isn't inside that, so we re-apply the exact same rules here (swap the .modal--settings prefix for .fwiz .fwiz-settings).`

The copy has already drifted: `.settings-subhead` is `margin: 18px 0 2px` in
`settings-polish.css` but `18px 0 8px` in the mirror. Every future polish to the settings
CSS silently fails to reach the wizard, and the expansion above would add much more UI
depending on that duplicated styling.

**3. The settings modal is cramped** for the amount it now holds.

## Goals

- Surface the missing settings inside the wizard without making it feel longer.
- Make `settings-polish.css` the single source of truth for both surfaces.
- Give the settings modal more room.

## Non-goals

- No changes to `WelcomeScreen.tsx` (the startup page). Explicitly out of scope.
- No backend/Rust changes. Every value and API needed already exists.
- Verbose logging stays Settings-only — a debugging toggle is the wrong altitude for onboarding.

---

## Part A — Settings modal size

Single rule in `src/styles/flint-2.css` (the `!important` block at ~line 144 that already
overrides the 756×518 base in `index.css`):

| Property | From | To |
|---|---|---|
| `max-width` | 960px | **1120px** |
| `height` | 640px | **720px** |
| sidebar `width` | 200px | **216px** |

`width: 86%` and `max-height: calc(100vh - 64px)` are unchanged, so small windows still fit.
The base rule in `index.css` is not touched.

## Part B — Shared settings CSS

Widen the selectors in `settings-polish.css` from `.modal--settings X` to a selector list
`.modal--settings X, .fwiz X`, then **delete the mirrored block in `flint-2.css`**
(lines ~596–918, from the `.fwiz-settings — the Settings design language ported…` banner up
to but not including the detect-bar section).

```css
/* before — modal only */
.modal--settings .settings-row { … }

/* after — both surfaces, one definition */
.modal--settings .settings-row,
.fwiz .settings-row { … }
```

Which rules get widened:

- **Widen** (surface-agnostic): `.settings-row*` and all its parts, `.settings-subhead`,
  `.settings-subhead__note`, `.settings-item*`, `.creator-field*`, `.creator-hero*`,
  `.settings-fcard*`, `.settings-duo`, `.theme-preset*`, `.theme-custom-accent*`,
  `.settings-assoc*`, `.dev-*`, `.settings-row__metric`.
- **Leave modal-scoped** (shell chrome the wizard has no analogue for): `.modal--settings`
  itself, `.modal__header` / `.modal__footer`, `.settings-sidebar*`, `.settings-content`,
  `.settings-panel*`.
- Rules already global (`.settings-toggle`, `.settings-hash*`, `.btn--success`, `.pkr*`)
  need no change.

The wizard keeps its `.fwiz-settings` wrapper class for layout, but styling comes from the
shared rules. Where the mirror had drifted, the `settings-polish.css` value wins — that file
is the one being treated as canonical.

**Verification:** every step of the wizard must be visually compared before/after. The mirror
is not a byte-identical copy, so removing it *will* shift a few values (subhead spacing being
the known one). That is the intended outcome — the wizard adopting the real settings CSS —
but it must be looked at, not assumed.

## Part C — Wizard content & layout

Steps stay **splash → theme → identity → paths → finish**. No new step.

### Layout mechanics

Add a `.fwiz-pane--split` two-column grid (collapsing to one column below ~900px) in
`flint-2.css` beside the existing `.fwiz-*` layout rules. `.fwiz__body` gets internal
scrolling so taller steps don't stretch the shell. No new component primitives — the panes
keep using `SettingsRow`, `PathSettingItem` and `ThemePresetGrid`.

### Theme step

Two columns: preset grid left, "Surfaces" controls right.

Adds **glass blur** and **glass opacity** sliders (rendered only while glassmorphism is on,
mirroring `SettingsModal`), **FPS Mode**, and **Button Glow**. FPS mode forces glow off and
disables its toggle — the same coupling `SettingsModal` uses.

These apply live via the `ux` store, matching how accent and glass already behave in the
wizard. See "Accepted risk" below.

### Identity step

Two columns: name + description left, links right. Adds **creator home URL** and
**creator tip link**, both optional and free-form (no URL validation — Settings doesn't
validate them either).

### Paths step

Two columns:

- **Left — workspace & game:** default project folder, League, PBE. Unchanged.
- **Right — launcher & editors:** the existing `LauncherPicker`, then a new **Editors** block
  for Jade and Quartz, plus the **auto-sync to launcher** toggle.

`detectAll()` stops discarding `ext.jade` / `ext.quartz` and writes them into new state.

**Auto-expand:** the Editors block renders collapsed as a one-line summary
("Jade & Quartz — optional, not detected") and expands automatically when detection finds
either one, showing the pre-filled row(s). Manual expand/collapse always available.

The detect bar's `filledCount` denominator goes from 4 to 5 to include editors, so its
progress fill stays honest.

### Finish step

Summary rows gain Jade/Quartz entries when set. A new **"One last thing"** block adds two
toggles:

- **Register file associations** — Windows "Open with" for `.wad`, `.bin`, `.tex`, `.fantome`,
  etc. Runs `api.registerFileAssociations()` on finish *only if enabled*. Failure shows a
  warning toast and **never blocks** entering Flint.
- **Automatic updates** — writes `config.setAutoUpdateEnabled`.

### Persistence

`handleFinish` extends to write: `jadePath`, `quartzPath`, `autoSyncToLauncher`,
`creatorHome`, `creatorTip`, `autoUpdateEnabled`. Appearance values (blur, opacity, FPS,
glow) persist through the `ux` store as they are applied live.

Creator name remains the only required field; every addition is optional.

## Accepted risk

The wizard applies theme changes **live** and does not roll them back if the user closes it
mid-flow. This is existing behavior for accent and glass; extending it to blur/opacity/FPS/glow
keeps it consistent rather than adding revert logic for a subset. Accepted deliberately.

## Verification

- `npx tsc --noEmit` clean.
- Walk the wizard end to end via Settings → Dev → "Replay Setup": every step renders, the
  stepper advances, Finish persists everything listed above.
- Visually diff each wizard step against the pre-change build (Part B will shift some spacing).
- Confirm the settings modal renders at 1120×720 and still fits a 1366×768 window.
- Confirm Settings and the wizard render `SettingsRow` / `PathSettingItem` identically —
  that is the whole point of Part B.
