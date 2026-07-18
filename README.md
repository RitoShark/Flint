<p align="center">
  <img src="docs/media/flint-logo.gif" alt="Flint" width="360"/>
</p>

<p align="center">
  <strong>The all-in-one desktop studio for League of Legends skin modding.</strong><br/>
  Extract from the game, preview it live, edit it, validate it, and ship a finished mod — all in one window.
</p>

<p align="center">
  <a href="https://github.com/RitoShark/Flint/releases/latest">
    <img src="https://img.shields.io/github/v/release/RitoShark/Flint?style=for-the-badge&color=EF4444&labelColor=0d1117&logo=github" alt="Release"/>
  </a>
  <img src="https://img.shields.io/badge/Windows-10%20%2F%2011-0d1117?style=for-the-badge&labelColor=0d1117&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI0VGNDQ0NCIgZD0iTTAgMy40NDlMOS43NSAyLjF2OS40NTFIMG0xMC45NDktOS42MDJMMjQgMHYxMS40SDEwLjk0OU0wIDEyLjZoOS43NXY5LjQ1MUwwIDIwLjY5OU0xMC45NDkgMTIuNkgyNFYyNGwtMTIuOS0xLjgwMSIvPjwvc3ZnPg==" alt="Windows"/>
  <img src="https://img.shields.io/badge/Rust-DEA584?style=for-the-badge&logo=rust&logoColor=white&labelColor=0d1117" alt="Rust"/>
  <img src="https://img.shields.io/badge/Tauri%202-24C8D8?style=for-the-badge&logo=tauri&logoColor=white&labelColor=0d1117" alt="Tauri"/>
  <img src="https://img.shields.io/badge/React%2018-61DAFB?style=for-the-badge&logo=react&logoColor=white&labelColor=0d1117" alt="React"/>
  <img src="https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge&labelColor=0d1117" alt="MIT"/>
</p>

<p align="center">
  <a href="https://github.com/RitoShark/Flint/releases/latest"><strong>⬇ Download the latest release</strong></a>
</p>

---

## What is Flint?

Flint replaces the tangle of CLIs, folder juggling, and half-a-dozen separate tools that skin modding normally takes. Point it at your League install, pull the assets you need, and Flint gives you a real project — with live 3D and texture previews, in-app editors for every League format, and one-click export to `.fantome` / `.modpkg` or straight into your launcher.

---

## Features

### Browse & extract
- **WAD Explorer** — a lazy-loaded virtual filesystem over the entire game archive. Browse millions of files with instant folder expansion, smart search, and optional background indexing.
- **CDN download & extract** — pull manifests straight from Riot's CDN by region/platform, see which you've already downloaded, and extract whole WADs, folders, or individual files with a selection bar.
- **Smart search** — one search box, Quartz-style matching. Extension searches, substring, or full regex — no mode toggles. Results stay collapsed so you're not buried in every file.

### Preview everything
- **3D models** — SKN / SKL / SCB / SCO meshes with skeletons and animations, framed correctly for champions of any size.
- **Textures** — DDS / TEX (BC1/BC3/BC5/BC7) rendered straight from raw bytes.
- **BIN / Ritobin / TroyBin / LuaBin** — syntax-highlighted, with live hash resolution.
- **Audio** — BNK / WPK / WEM with a zoomable waveform.

### Edit in place
- **BIN editor** — a full Monaco editor with a custom Ritobin language, an emitter copy/drag palette for VFX work, one-click **Unhash**, and bracket-aware editing.
- **Legacy format editors** — edit `.inibin` / `.cfgbin`, `.stringtable` (RST), and more as readable text; view `.troybin`, `.luabin64`, and `.manifest`.
- **WAD editor** — edit, add, rename/move, and delete chunks inside a `.wad.client` and save it back, parallelized for speed.
- **Archive editor** — open a `.fantome` / `.modpkg`, edit its metadata and inner WADs, and repack it — folder-form WADs stay folders so custom paths survive.

### Special workflows
- **Animated loading screens** — drop a video in, get a working animated loadscreen out. Auto spritesheet packing, 16k texture budget, FPS trim, live preview, and automatic UI BIN patching.
- **Animated loadscreen banner** — turn a static loadscreen into an animated VFX banner with a Photoshop-style mask painter.
- **Texture recolor** — batch hue-shift, colorize, or tint; skips distortion maps and preserves alpha.
- **Checkpoints** — Git-lite for your project. Snapshot, diff, and restore; survives restarts.

### Ship it
- **Export everywhere** — `.fantome`, `.modpkg`, or one-click sync into the **Celestial** launcher or **LTK Manager**. Refathering, BIN concat, and thumbnail embedding are all built in.
- **Robust importing** — imports `.fantome` / `.modpkg`, recovers moved/renamed shared BINs across game patches, re-resolves hashes, and pulls missing files back from your League install.
- **Interop** — hand a BIN off to Jade or a texture off to Quartz paint mode, no file juggling.

---

## Quick start

**Just want to use it?** [Download the latest installer](https://github.com/RitoShark/Flint/releases/latest) and run it. Flint auto-updates itself from there.

### Build from source

```bash
git clone https://github.com/RitoShark/Flint
cd Flint

npm install
npm run tauri dev
```

<details>
<summary><strong>Prerequisites</strong></summary>

| Tool | Version |
|------|---------|
| Rust | 1.75+ ([rustup](https://rustup.rs)) |
| Node | v20+ ([nodejs.org](https://nodejs.org)) |
| OS   | Windows 10 / 11 |

</details>

<details>
<summary><strong>Build a release installer</strong></summary>

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/nsis/Flint_<version>_x64-setup.exe`

</details>

---

## Theming

Flint is fully CSS-variable themed. Copy [src/themes/default.css](src/themes/default.css) and override the accent palette:

```css
:root {
  --accent-primary:   #EF4444;  /* Flint red */
  --accent-hover:     #DC2626;
  --accent-secondary: #F87171;
  --accent-muted:     #991B1B;
}
```

---

## Contributing

PRs welcome. Keep commits [conventional](https://www.conventionalcommits.org) — `feat:`, `fix:`, `perf:`, `refactor:`, `doc:` — they feed the changelog via [git-cliff](cliff.toml).

```bash
git checkout -b feat/your-feature
# hack hack hack
git commit -m "feat(scope): short imperative message"
```

---

## License

[MIT](LICENSE) — do whatever, just don't sue.

> League of Legends, all champion art, and all referenced game assets are property of **Riot Games, Inc.** Flint is an unofficial community tool and is not endorsed by or affiliated with Riot Games.
