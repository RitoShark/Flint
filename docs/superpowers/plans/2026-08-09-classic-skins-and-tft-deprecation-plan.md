# Classic (Jade) skin projects + TFT deprecation — Plan

**Date:** 2026-08-09
**Status:** Proposed

---

## Part 0 — Research findings (verified against live CDragon, 2026-08-09)

League Classic shipped 2026-07-29 (patch 26.15). Its internal codename is **Jade**,
and that codename is what the game data actually uses — not "classic".

### CommunityDragon: fully resolved

| Endpoint | Jade support |
|---|---|
| `v1/champion-summary.json` | **Yes** — 60 extra entries, `id = 60000 + liveId`, `alias = "Jade_<Champion>"` (e.g. `60103` / `Jade_Ahri`). Total entries 234. |
| `v1/champions/<id>.json` | **Yes** — `champions/60103.json` returns 8 skins for Jade Ahri. |
| `v1/skins.json` | **Partial** — only the 32 `Classic <Champ>` entries (suffix 301, one 302). The jade *ports* of live skins are NOT in this flat map. Enumerate per champion instead. |
| `v1/champion-icons/60001.png` | **Yes** (200). |
| `v1/champion-splashes/60001/60001301.jpg` | **No** (404). Use `skin.splashPath` from the champion JSON instead — that resolves fine. |
| `v1/jade-champions.json` | **Yes** — the authoritative 60-champion roster (`mChampions[].value.championId`). |
| `v1/jade-items.json`, `jade-perks.json`, `jade-hub.json`, `jade-rune-pages.json`, `jade-mastery-display.json` | Present (not needed for skins). |
| `plugins/rcp-fe-lol-jade` | Present (LCU frontend plugin). |
| `game/data/characters/jade_annie/skins/skin301.bin` | **Yes** — full BIN tree exists in the extracted game export. |
| `game/assets/characters/jade_*` | **Yes** — 84 `jade_*` character folders. |

### DataDragon: no support

`ddragon` has no Jade champions and no `Jade_*` champion JSON. It is live-roster
only. Flint's DDragon fallback in `fetchChampionSkins` will never help here — it
must not be relied on for classic.

### ID / path conventions (all verified)

```
championId   = 60000 + liveChampionId          60103  = Jade Ahri
alias        = "Jade_" + liveAlias             Jade_Ahri
skinId       = championId * 1000 + skinNum     60103301
skinNum      = skinId % 1000                   301
BIN path     = data/characters/jade_ahri/skins/skin301.bin
asset root   = ASSETS/Characters/Jade_Ahri/Skins/Skin301/
splash       = .../images/jade_ahri_splash_centered_301.project_jade.jpg
loadscreen   = .../Jade_AhriLoadScreen_301.project_jade.jpg  (+ `_301_LE` vintage)
```

- **`Skin301` is the Classic skin.** Exactly one per champion that got a visual
  update; champions whose current look is already the original (e.g. **Ashe**)
  have **no** 301 entry. Don't assume every jade champion has one.
- **`Skin302/303/305` are chromas of the Classic skin** and are real `skinNNN.bin`
  files (verified in `jade_annie/skins/`). `id % 1000` already handles them.
- Jade champs also carry *ports* of a subset of live skins (`Jade_Annie` has
  skin1/5/8/9/11/12/22/60 …). Those are moddable too.
- Every jade asset filename carries a `.project_jade` infix before the extension.

### WAD layout — corrected

There is **no `Jade_Ahri.wad.client`.** Jade champions ship inside the **live
champion's WAD**: `Jade_Ahri` lives in `Ahri.wad.client` under
`data/characters/jade_ahri/`. So only the WAD *filename* drops the prefix —
every character-folder path keeps it. `project.champion` therefore stays the full
`Jade_Ahri`, and a single `wad_champion_name()` helper strips the prefix at the
handful of sites that build a `.wad.client` name.

---

## Part A — Classic skin project creation

### A1. Champion source (`src/lib/data/datadragon.ts`)

`fetchChampions` filters `c.id > 0 && c.id < 10000`, which silently drops every
jade champion today. Add a second fetcher over the same `champion-summary.json`
payload (one network call, two views) rather than loosening the filter:

- `fetchJadeChampions(branch)` → keeps `id >= 60000 && id < 70000`, returns
  `{ id, name, alias }` with `alias` kept verbatim (`Jade_Ahri`) and `name` used
  for display. Cache per branch like the live list.
- Cross-check the result against `jade-champions.json` only if the summary ever
  drifts; the summary is enough on its own.

### A2. Skins per champion

`fetchChampionSkins(60103)` already works unchanged — it hits
`champions/${championId}.json` and `mapCDragonSkins` derives `num = id % 1000`,
which is correct for `0`, `27`, `301`, `302`. **No change needed.**

Sort/label: surface `Classic <Champ>` (301) first in the picker, since that's
what people come for; the jade ports follow.

### A3. Images

- Icons: `getChampionIconUrl(60001)` → 200, works as-is.
- Splash: `getSkinCenteredSplashUrl` prefers `skin.splashPath` → works.
- `preloadSkinSplashes` falls back to `getSkinSplashCDragonUrl(championId, skinId)`
  when `splashPath` is missing — that endpoint 404s for every jade skin. Guard the
  fallback so jade ids skip it (falling back to `tilePath`, else no preload).

### A4. Project creation

`create_project(name, champion, skin_id, league_path, output_path, …)` is called
with `champion = "Jade_Ahri"`, `skin_id = 301`. Every character-folder derivation
(`wad_contains_skin_bin`, the extraction seed, `find_main_skin_bin`) already does
`champion.to_lowercase()` and lands on `jade_ahri` unchanged. The only thing that
must be adjusted is the `.wad.client` filename, via `wad_champion_name()` in
`flint-wad/src/wad/extractor.rs`, applied at:

- `find_champion_wad` (extractor **and** adapter — two copies exist)
- both `extract_skin_assets*` `wad_folder_name`s
- `repath/refather.rs` and `repath/organizer.rs` (config wad folder +
  `find_main_skin_bin`, whose `patterns` keep the `jade_` prefix)

### A5. Project metadata

Do **not** add a new `ProjectKind`. A classic project is a skin project in every
respect (same WAD, same BIN layout, same preview, same export). Instead:

- Keep `kind: 'skin'`.
- Add an optional `variant?: 'classic'` (plus the champion alias already stored)
  to `mod.config.json` / `flint.json`, so the UI can badge the tab and so future
  tooling (Skin Fixer, previews) can tell a jade project apart without
  string-sniffing the alias.

### A6. UI

Do **not** add a fifth type card. Add a **"Classic" switch in the modal footer,
right next to the PBE switch** (same `np-pbe-toggle` markup, skin projects only).

Switching it on swaps the champion list to `fetchJadeChampions`; everything
downstream (skin picker, chroma popup, hero splash, create button) is the
identical code path. With the switch on, `loadSkins` sorts `isClassicSkin`
(num ≥ 300) to the front and selects it, so picking Ahri lands on **Classic
Ahri** rather than the base jade port. Champions with no classic skin (Ashe)
fall back to base. The jade ports of live skins stay in the list — they are
moddable too.

### A7. Tests

- `datadragon` unit test: a fixture summary containing `103` and `60103` →
  `fetchChampions` returns only `103`, `fetchJadeChampions` only `60103` with
  alias `Jade_Ahri`.
- `mapCDragonSkins` test asserting `60103301 → num 301` and `60001302 → num 302`.
- A creation smoke test is not automatable without a game install; verify by hand.

---

## Part B — TFT deprecation

Rationale to communicate: TFT is moving to Unreal Engine. Support cannot be
maintained. While Riot keeps the existing companions on the current engine the
tool keeps working, but it can break or be pulled at any time.

### B1. "Will be removed" tag on the type card

`NewProjectModal.tsx` — the TFT `np-type-card` gets a badge element alongside the
label:

```tsx
<span className="np-type-card__badge np-type-card__badge--deprecated">Will be removed</span>
```

Style it in `src/styles/new-project-polish.css` next to the existing
`np-type-card--experimental` rules. Centre it with the card's flex layout — no
hand-tuned pixel offsets (ecosystem UI rule).

### B2. Deprecation dialog on selecting TFT

`handleSelectExperimentalType('tft')` currently opens the shared "Experimental
Feature" dialog whose copy is `{tft|map} projects are experimental…`. Split it:
`map` keeps the current copy, `tft` gets its own title/body:

> **TFT support is going away**
>
> TFT is moving to Unreal Engine, and I can't commit to maintaining support for
> it. As long as Riot keeps the existing companions on the current engine this
> will keep working — but it can break or be removed at any time.

Actions stay `Cancel` / `Continue anyway`. No header `×` (there's a Cancel —
ecosystem UI rule).

### B3. Same notice when OPENING an existing TFT project

Creation-time warning isn't enough — most people hit this on a project they
already have. On opening a project with `kind === 'tft'`, show the same notice
once, with a "Don't show this again" checkbox persisted to localStorage
(`flint_tft_deprecation_ack`, same pattern as `flint_verbose_logging` /
`unknownPreviewByExt`).

### B4. Tag wherever the kind is shown

Anywhere a TFT project's kind renders (project tab, recents list, project info),
append the same small "Will be removed" pill so it's visible outside the
creation flow.

### B5. Not in scope

Removing the TFT code path. It stays working until Riot's migration actually
breaks it; this change is messaging only.

---

## Suggested commit slices (Conventional Commits, per repo style)

1. `feat(new-project): flag TFT as deprecated` — B1 + B2.
2. `feat(project): warn on opening a TFT project` — B3 + B4.
3. `feat(data): fetch League Classic champions from CDragon` — A1 + A3 + A7.
4. `feat(new-project): create projects from the League Classic roster` — A6 + A5.
5. `doc: record jade/classic conventions` — CLAUDE.md note with the ID/path table.
