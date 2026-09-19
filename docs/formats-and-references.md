# Files, hashes and references

[Documentation index](README.md) · [Projects](projects.md)

A skin is a set of files connected by references. A BIN can select a mesh, texture, animation or another BIN. Editing the referenced resource changes what is shown; moving it without updating its reference can leave the game looking at the old path.

## Common formats

| Format | Role in Flint |
|---|---|
| `.wad.client` | Archive containing game assets indexed by path hash. Browse/extract it to work on the inner files. |
| `.bin` | Typed property data, including asset references and linked BIN content. Flint displays an editable ritobin representation. |
| `.ritobin` / ritobin text | Human-readable representation of BIN data. Text syntax and value types matter when encoding back to binary. |
| `.skn`, `.skl` | Skinned mesh and skeleton. A correct model preview can need both and its referenced textures. |
| `.scb`, `.sco` | Static mesh formats. |
| `.anm` | Animation data used with a compatible skeleton. |
| `.dds`, `.tex` | Texture containers. Their extension alone does not establish their compression format or game compatibility. |
| `.bnk`, `.wpk`, `.wem` | Audio banks/containers and audio resources. SFX and localized voiceover can live in different WADs. |
| `.mapgeo` | Map geometry, used with material data and textures for map preview. |
| RMAN manifest | CDN file catalog plus chunk/bundle reconstruction metadata. It is not the asset archive itself. |
| `.fantome`, `.modpkg` | Mod distribution packages produced by export and read by import workflows. |

## Why some names are hexadecimal

WADs identify an inner path using `xxh64(lowercase(path))` with seed zero. BIN entry/class/field names use a different convention, FNV1a-32 of lowercase names. A BIN `file` value is a 64-bit path hash; a `hash` value is not interchangeable with it.

Hashing is one-way. Flint uses shared LMDB dictionaries to display known names, but an unknown hash cannot be inverted into its original name. If a CDN asset displays as hex, the archive entry can still exist and be downloadable.

Custom repaths invent names such as `assets/mycreator/my-skin/texture.tex`. These names are not necessarily in any public dictionary. Flint records custom names in the project's `files.txt`; supported embedded hashtables use project `hashes/` files and metadata in `mod.config.json`. Preserve these alongside the assets when sharing or moving a project. Flint also understands supported incoming BIN name records, but its current authoring workflow keeps its own name record outside the BIN.

## Repath and dependency examples

Suppose a BIN refers to `assets/characters/ahri/skins/skin27/body.tex`. Repathing can change that reference to `assets/mycreator/my-skin/body.tex` and relocate the texture to the same relative location beneath the project's WAD directory. Both changes are needed. Merely changing `repath_prefix` in `flint.json` changes metadata, not that reference or file.

A downloaded `.skn` alone is not a complete animated model. Gather its skeleton, textures, animations and relevant BIN data if the intended use needs them. Similarly, extracting a single BIN from CDN does not automatically fetch its dependency graph.

A mod need not include every stock file it references: the installed game can supply unchanged resources. A custom path has no such fallback unless the mod supplies it. This distinction is why audit findings must be interpreted in context.

## Format checks before shipping

Use **Check files** after asset replacement, reference changes or importing older content. BIN types can change between game builds, and syntactically valid text can still represent the wrong type for the current game. Recording `source.game_version` documents where a project began; it does not migrate the data.

Texture previews can read formats that should not be exported in the same container for League. Flint's DDS export is limited to BC1, BC3 and BGRA8; BC5/BC7 belong in TEX for this workflow. Keep the intended format and alpha behavior when replacing a texture, and inspect the audit rather than relying on the filename extension.

For optional editor completion/diagnostics, see [ritobin LSP](ritobin-lsp.md). For implementation-oriented BIN validation notes, see [BIN schema checks](bin-schema-checks.md).
