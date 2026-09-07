<img align="left" width="300" src="flint-logo.png" alt="Flint">

### Flint

A skin modding studio for League of Legends.

<br clear="left">

---

[![Rust](https://img.shields.io/badge/Rust-stable-orange?style=flat-square&logo=rust)](https://www.rust-lang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8D8?style=flat-square&logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react)](https://react.dev/)
[![Release](https://img.shields.io/github/v/release/RitoShark/Flint?style=flat-square&color=f5a422)](https://github.com/RitoShark/Flint/releases/latest)
[![License](https://img.shields.io/badge/License-AGPL--3.0-22c55e?style=flat-square)](LICENSE)

[Download](#download) · [Features](#features) · [License](#license)

<div align="center">

<img src="docs/media/flint-logo.gif" alt="Flint" width="900">

</div>

---

Point Flint at your League install, pick a skin, and you get a real project — files on disk,
previews that render properly, editors for the formats League actually uses, and an export that
produces something installable. It replaces the pile of separate CLIs and folder shuffling that
skin modding usually takes.

---

## Features

<details open>
<summary><b>Projects</b> · pull a skin out of the game and get something you can work on</summary>

<br>

Pick a champion and a skin. Flint extracts it, repaths it onto your own asset folder, and lays it
out as a project — not a heap of files named after hashes.

- Chromas and sub-characters come along with it.
- Checkpoints snapshot the whole project before a risky change, and roll it back when the change
  turns out to be a mistake. They survive restarts.
- Importing works the other way: drop in a `.fantome` or `.modpkg` and Flint recovers the shared
  BINs Riot moved between patches, re-resolves the hashes, and pulls anything still missing back
  out of your install.
- Port a skin to League Classic, strip it down for NoSkinLite, or push a base skin's edits across
  all of its chromas.

</details>

<details>
<summary><b>WAD explorer</b> · browse the whole game like a folder</summary>

<br>

Every file in the game archive, in a tree that expands instantly instead of making you wait for a
full index.

- One search box. Type an extension, a substring, or a regex — there is no mode to switch.
  Results stay collapsed so a common word doesn't bury you.
- Names resolve to readable paths, so you're not reading hex.
- Or skip your install entirely: pull a manifest straight from Riot's CDN by region and patch, and
  extract whole WADs, single folders, or one file.

</details>

<details>
<summary><b>Preview</b> · look at things before you break them</summary>

<br>

- **Models** — SKN, SKL, SCB and SCO, with skeletons and animations, framed correctly whether it's
  Teemo or Cho'Gath.
- **Textures** — DDS and TEX decoded from raw bytes, BC7 included.
- **Audio** — BNK, WPK and WEM on a waveform you can zoom into and cut.
- **Maps** — in their own window.
- **The rest** — BIN, ritobin, troybin, luabin, RST string tables, inibin and cfgbin, manifests.
  Most of them are editable, not just readable.

</details>

<details>
<summary><b>BIN editing</b> · a real editor, not a text box</summary>

<br>

Monaco with a proper ritobin language behind it — highlighting, folding, a minimap, and bracket
checking that understands blocks instead of counting braces, so it only speaks up when something
is genuinely unbalanced.

- **Unhash** in one click, and names you make up yourself stick to the file.
- An emitter palette for VFX work — copy or drag emitters between files.
- A VFX paint panel for recoloring particles without hand-editing values.
- Compare two BINs properly, whole file, not a selection of hunks.
- An optional [ritobin language server](docs/ritobin-lsp.md) for completion and diagnostics. Off by
  default, and it downloads no hashes of its own — names come from your local database.

</details>

<details>
<summary><b>3D editor</b> · edit the mesh, not just look at it</summary>

<br>

- Delete submeshes, and paste geometry between two files — remapped by joint name, because raw
  blend indices mean nothing across two different skeletons.
- Paint weights, with an x-ray view of the skeleton underneath.
- Cut a skin's textures into Photoshop layers along their UV islands, so you can paint on the parts
  instead of on one flat atlas.

</details>

<details>
<summary><b>Thumbnails and loadscreens</b> · the art side</summary>

<br>

- **Thumbnail studio** — pose the model, pick a background, add text and shapes, export a PNG for
  the mod post.
- **Animated loading screens** — drop in a video and get a working one out. Spritesheet packing,
  texture budget, FPS trim and the UI BIN patching all happen for you.
- **Loadscreen banner** — turn a static loadscreen into an animated one, with a mask painter for
  the parts that should show through.
- **Recolor** — hue shift, colorize or tint a whole folder at once. It skips distortion maps and
  keeps alpha, so it doesn't quietly wreck your normals.

</details>

<details>
<summary><b>Checking and fixing</b> · find out what's broken before the player does</summary>

<br>

**Check files** scans the project and tells you what's wrong: references pointing at nothing, the
things that actually crash the client, files nothing uses, and fields Riot retyped in a patch and
your mod hasn't followed.

Findings open where they really are — the file gets selected in the tree, and a BIN finding opens
at its line.

**Skin Fixer** runs Hematite across one or more projects. It scans first and shows you what it
found before it touches anything, and takes a checkpoint before it runs.

</details>

<details>
<summary><b>Shipping</b> · get it out of Flint</summary>

<br>

Export a `.fantome` or a `.modpkg`, or sync straight into the **Celestial** launcher or **LTK
Manager**.

Export warns you about references pointing at files that aren't in the package, rather than
producing a mod that silently loads nothing.

You can also hand a BIN off to Jade or a texture to Quartz without juggling files between them.

</details>

---

## Download

Grab the latest build from the [releases page](https://github.com/RitoShark/Flint/releases/latest),
run the installer, and you're done. It updates itself after that.

> [!NOTE]
> Flint needs a League install for anything that reads game files — extraction, previews, recovering
> missing files on import. Editing a project you already have works without one.

<details>
<summary><b>Build it yourself</b></summary>

<br>

Needs Rust (stable), Node 20, and Windows 10 or 11.

```bash
git clone https://github.com/RitoShark/Flint
cd Flint
npm install
npm run tauri dev
```

`npm run tauri build` produces an installer at
`src-tauri/target/release/bundle/nsis/Flint_<version>_x64-setup.exe`.

</details>

## Notes

- This project is not affiliated with Riot Games. League of Legends and its assets belong to Riot.
- Contributions are welcome. Commits follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `perf:`, `refactor:`, `doc:`) because the changelog is generated from them.

## Credits

[LtMAO](https://github.com/tarngaina/LtMAO) by [tarngaina](https://github.com/tarngaina) — the
toolpack most League modders learned on. Its `animask_viewer` and `sborf` were the reference for
Flint's animation mask editor, and confirmed that `mWeightList` is indexed by SKL joint order.

## License

[AGPL-3.0](LICENSE). Free to use, study, modify and share.

If you distribute a modified version — or run one somewhere other people use over a network — you
have to release your source under the same license.
