# RitoShark additions Flint needs (owner implements → push to `main`)

This is the literal list. Implement in `RitoShark-Crates`, push to `main`, ping me, I bump Flint's
git rev and wire it up. Until then I work around it (Flint keeps the `league-toolkit` path for these
two bits only; everything else migrates now).

---

## 1. `rs_wad`: `WadBuilder` + zstd encoder  — **REQUIRED**

**Why:** `rs_wad` reads + byte-exact round-trips an existing archive, but can't *build* one from loose
files (no builder, no compressor). Flint's exporters (Fantome / ModPkg / LTK-Manager sync) need to
assemble a WAD v3.4 from a project's files. This is the only gap that genuinely belongs in the format
crate.

**Desired public API** (match the shape so Flint's `export/mod.rs` call site stays simple — it builds
hundreds of MB, so it must **stream**, not hold every file in RAM):

```rust
// rs_wad
pub struct WadBuilder { /* registered (path_hash) entries, version */ }

impl WadBuilder {
    pub fn new() -> Self;                                   // defaults to v3.4
    pub fn with_version(self, major: u8, minor: u8) -> Self;

    /// Register a chunk by its in-WAD path. Hashes it (XXH64, seed 0, lowercased).
    pub fn add_chunk(&mut self, path: &str);
    pub fn with_chunk(self, path: &str) -> Self;            // builder-style

    /// Stream-build: for each registered chunk, `provide(path_hash, &mut writer)` writes that chunk's
    /// UNCOMPRESSED bytes. Builder compresses (zstd), dedups, lays out TOC+data, writes the archive.
    pub fn build_to_writer<W: Write, F>(self, out: &mut W, provide: F) -> Result<()>
        where F: FnMut(u64, &mut dyn Write) -> Result<()>;

    pub fn build_to_bytes<F>(self, provide: F) -> Result<Vec<u8>>
        where F: FnMut(u64, &mut dyn Write) -> Result<()>;
}
```

**Semantics that matter for correctness:**
- **Compression:** zstd (`WadCompression::Zstd`). Per chunk store uncompressed + compressed sizes and
  the chunk checksum your `WadChunk` layout expects (XXH3-64 of the compressed bytes, per v3.4).
- **Dedup:** identical chunk data is stored **once** in the data section; multiple chunks may point at
  the same offset/size. (Matches what the game ships and keeps mod size down.)
- **TOC:** sorted ascending by `path_hash`; data offsets computed after dedup.
- **Header:** version (3,4); whatever `header_trailer` your reader expects on round-trip.

**Correctness bar (NOT byte-identical to league-toolkit):** zstd level/dict differences mean compressed
bytes legitimately differ from LTK output. The bar is: the archive is valid v3.4, the game/tools accept
it, and `rs_wad::Wad::from_bytes` → `chunk_data` decompresses every chunk back to the exact input bytes.
Flint will guard this with a build→parse→decode round-trip test on real project files.

**Nice-to-have (skip if annoying):** expose the symmetric `rs_wad::compress(data, WadCompression, level)`
next to the existing `decompress`, and let `WadBuilder` take an optional zstd level (default ~3).

---

## 2. `rs_bin`: serde / JSON  — **OPTIONAL** (I'll do it Flint-side otherwise)

**Why:** Flint has `convert_json_to_bin` (frontend calls it; `convert_bin_to_json` looks unused).
JSON only round-trips transiently in the editor, so the shape is free — it just needs `bin→json→bin`
self-consistency.

**If you want it in the lib:** `#[derive(serde::Serialize, serde::Deserialize)]` on `Bin` / `BinEntry`
/ `BinValue` / `BinType` (behind a `serde` feature), plus:

```rust
pub fn to_json(bin: &Bin, mapper: Option<&HashMapper>) -> Result<String>;
pub fn from_json(json: &str) -> Result<Bin>;
```

**If you'd rather not:** say so and I'll implement it inside `flint-ltk` over `BinValue` — zero changes
to your lib. (My default, unless you prefer it lives with the format.)

---

## Not on this list (handled elsewhere)

- **Hematite** — you're updating it to talk to RitoShark yourself. Flint will adapt `fixer.rs` to the
  new API once you ping me. (Until then `league-toolkit` stays in the tree transitively via Hematite.)
- Everything else Flint uses (`rs_tex` decode/encode + raw blocks, `rs_mesh`, `rs_anim`, `rs_hash`,
  `rs_rst`, `rs_audio`, `rs_file::detect`, `rs_bin` read/write/`from_text`/`to_text`, `rs_wad`
  read/extract) is **already sufficient** in `fb7832e` — no changes needed.
