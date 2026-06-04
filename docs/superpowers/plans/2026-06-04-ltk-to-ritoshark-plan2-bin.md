# LTK → RitoShark Migration — Plan 2 (BIN) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this task-by-task. Steps use checkbox (`- [ ]`).

**Goal:** Migrate Flint's BIN handling (`ltk_meta` + `ltk_ritobin`) onto RitoShark's `rs_bin`, keeping `flint-ltk`'s public BIN API stable.

**Architecture:** One interconnected type swap: `ltk_meta::{Bin, PropertyValueEnum}` → `rs_bin::{Bin, BinValue}`. The CORE (`bin/ltk_bridge.rs`, `converter.rs`, `lib.rs` re-exports) migrates first and establishes the types; then the tree-walk consumers are rewritten over the flat `BinValue`. Both libs coexist; this plan does not remove `league-toolkit` (Plan 4 does).

**Tech Stack:** Rust, `ritoshark::bin` (= `rs_bin`), `ritoshark::hash::HashMapper`, `cargo clippy` gate.

**Key insight:** The flat `BinValue` is SIMPLER than ltk's typed sub-enums. `List/Map/Option/Pointer/Embed` all hold `BinValue` children, so recursive walks just match `BinValue` and recurse — the `Container::String` vs `Container::Struct` distinction disappears. Type introspection is preserved via the `item`/`key`/`value: BinType` fields. No type loss.

---

## The two models

**ltk_meta (today):** `Bin { objects: IndexMap<u32, BinObject>, dependencies: Vec<String> }`; `BinObject { class_hash, properties: IndexMap<u32, BinProperty> }`; `BinProperty { value: PropertyValueEnum }`; `PropertyValueEnum::{ String(s){s.value}, Bool(v){v.value}, …, Struct(s){s.class_hash,s.properties}, Embedded(e){e.0…}, Container(c), UnorderedContainer(uc){uc.0}, Optional(o), Map(m) }` + typed sub-enums `Container::{String{items},Struct{items},Embedded{items}}`, `Optional::{String,Struct,Embedded}(Option<…>)`, `Map` (private entries).

**rs_bin (target):** `Bin { is_patch, patch_header, version, linked: Vec<String>, entries: Vec<BinEntry>, patches }`; `BinEntry { path_hash, class_hash, fields: IndexMap<u32, BinValue> }`; flat `BinValue` (see `crates/rs_bin/src/bin.rs:93`). `Bin::new()` makes an empty v3 doc; no builder; public fields. `BinValue::ty() -> BinType`.

## Translation table (apply everywhere)

| ltk_meta | rs_bin |
|---|---|
| `Bin::from_reader(&mut cur)` | `Bin::from_bytes(&data)?` (`use ritoshark::prelude::Parse as _`) |
| `tree.to_writer(&mut buf)` | `bin.to_bytes()?` (`use ritoshark::prelude::Serialize as _`) |
| `Bin::builder().objects(v).build()` | `Bin { entries: v, ..Bin::new() }` |
| `Bin::new(empty_objects, empty_deps)` | `Bin::new()` |
| `bin.objects.retain(\|h,o\| …)` | `bin.entries.retain(\|e\| … e.path_hash …)` |
| `bin.objects.get(&h)` / `.contains_key(&h)` | `bin.entries.iter().find(\|e\| e.path_hash==h)` / `.any(…)` |
| `bin.dependencies` | `bin.linked` |
| `BinObject { class_hash, properties }` | `BinEntry { path_hash, class_hash, fields }` |
| `prop.value` (BinProperty) | the `BinValue` itself (fields: hash→BinValue, no wrapper) |
| `String(s)`+`s.value` | `BinValue::String(s)` (s is `String`) |
| `Bool(v)`+`v.value` / `BitBool` | `BinValue::Bool(b)` / `BinValue::Flag(b)` |
| `I8/U8/…/F32(v)`+`v.value` | `BinValue::I8/U8/…/F32(n)` (n is the scalar) |
| `Vector2(v)`+`v.value.x/.y` | `BinValue::Vec2([x,y])` → `a[0]`,`a[1]` (Vec3/Vec4 similar) |
| `Color(v)`+`v.value` | `BinValue::Rgba([r,g,b,a])` |
| `Hash(v)`/`ObjectLink(v)`/`WadChunkLink(v)`+`v.value` | `BinValue::Hash(u32)` / `BinValue::Link(u32)` / `BinValue::File(u64)` |
| `Struct(s)` [`s.class_hash`,`s.properties`] | `BinValue::Pointer { class, fields }` |
| `Embedded(e)` [`e.0.class_hash`,`e.0.properties`] | `BinValue::Embed { class, fields }` |
| `Container(c)` + `c.clone().into_items()` | `BinValue::List { is_list2:false, item, items }` → iterate `items` |
| `UnorderedContainer(uc)` [`uc.0`] | `BinValue::List { is_list2:true, item, items }` |
| `Container::String { items, .. }` | `List{item:BinType::String, items}` → each item is `BinValue::String(_)` |
| `Container::Struct { items, .. }` | `List{item:BinType::Pointer, items}` → each is `BinValue::Pointer{..}` |
| `Container::Embedded { items, .. }` | `List{item:BinType::Embed, items}` → each is `BinValue::Embed{..}` |
| `c.item_kind()` | `list.item` (BinType) |
| `Optional(o)` + `o.clone().into_inner()` | `BinValue::Option { item, value }` → `value.as_deref()` |
| `Optional::String/Struct/Embedded(Some(x))` | `Option{value:Some(b)}` then match `*b` as `BinValue::String/Pointer/Embed` |
| `o.is_some()` / `o.item_kind()` | `option.value.is_some()` / `option.item` |
| `Map(m)` + `m.entries()` | `BinValue::Map { key, value, entries }` → `&map.entries` (Vec) |
| `std::mem::take(m).into_entries()` … `Map::new(k,v,e)` | mutate `map.entries` in place: `for (k,v) in map.entries.iter_mut()` |
| `m.key_kind()` / `m.value_kind()` | `map.key` / `map.value` (BinType) |
| `s.properties.values()` / `.values_mut()` | `pointer.fields.values()` / `.values_mut()` |
| `for (h,prop) in &s.properties` | `for (h,val) in &pointer.fields` (val IS BinValue) |
| `PropertyKind` | `BinType` |
| `ltk_ritobin::write_with_hashes(tree, hashes)` | `rs_bin::to_text(&bin, Some(&mapper))` |
| `ltk_ritobin::parse_to_bin_tree(text)` | `rs_bin::from_text(text, None)?` |
| `HashProvider` / `HashMapProvider` | `ritoshark::hash::HashMapper` |
| `serde_json::to_string_pretty(&bin)` | Flint-side `bin_json::to_json(&bin)` (BinValue isn't serde) |

**Recursive-walk collapse:** `repath_value`'s nested `Container::{String,Struct,Embedded}` and `Optional::{…}` arms collapse to: `List{items,..} => for v in items { walk(v) }`, `Option{value:Some(b),..} => walk(b)`, `Map{entries,..} => for (k,v) in entries { walk(k); walk(v) }`, `Pointer{fields,..}|Embed{fields,..} => for v in fields.values() { walk(v) }`. The leaf mutation is `BinValue::String(s) => { /* edit s in place */ }`.

---

## Execution order

### Phase 2.0 — CORE (LEAD, serial). Establishes the types; intentionally breaks consumers.
**Files:** `bin/ltk_bridge.rs`, `bin/converter.rs`, NEW `bin/bin_json.rs`, `lib.rs` (re-exports).
- [ ] `ltk_bridge.rs`: `read_bin`→`Bin::from_bytes`, `write_bin`→`bin.to_bytes()`, `tree_to_text_with_hashes`→`rs_bin::to_text(&bin, Some(&mapper))`, `text_to_tree`→`rs_bin::from_text(text, None)`. Replace `HashMapProvider` cache with `OnceLock<RwLock<HashMapper>>`; `load_bin_hashes` inserts LMDB entries via `HashMapper::insert(hash as u64, name)`. **Verify** how `rs_bin::to_text` looks up u32 hashes in the u64-keyed `HashMapper` (read `crates/rs_bin/src/text/print.rs`) — widen consistently.
- [ ] `bin_json.rs` (NEW): `pub fn to_json(&Bin)->Result<String>` + `pub fn from_json(&str)->Result<Bin>` — a serde mirror over `BinValue` (or manual `serde_json::Value` build). Shape only needs bin→json→bin self-consistency.
- [ ] `converter.rs`: point `bin_to_json`/`json_to_bin` at `bin_json`.
- [ ] `lib.rs::ltk_types`: replace BIN re-exports — `pub use ritoshark::bin::{Bin, BinEntry, BinValue, BinType};` and DELETE `BinObject, BinProperty, PropertyKind, PropertyValueEnum, values::*, HashProvider, HashMapProvider, write_with_hashes`. Add `pub use ritoshark::hash::HashMapper;`.
- [ ] Do NOT gate yet (consumers are broken).

### Phase 2.1 — CONSUMERS (parallel agents, one per file-group). Each gets this translation table.
- [ ] **Agent `repath`**: `repath/refather.rs` — rewrite `repath_value` (MUTATE) + `collect_paths_from_value` (READ) using the recursive-walk collapse. Hardest; the `Map` mutation simplifies to in-place `entries` edit.
- [ ] **Agent `paths`**: `wad/extractor.rs::collect_paths_from_value_into` + `mesh/animation.rs::extract_animation_paths_from_value` — both read-only path collectors (do NOT touch `league_toolkit::wad` reads in extractor.rs — only the BinValue walk).
- [ ] **Agent `schema`**: `commands/league/champion_schema.rs` + `commands/system/dev.rs` — `collect_nested`/`render_value` and `extract_range`/`describe_value`/`recurse_*`. Use `list.item`/`map.key`/`map.value`/`option.item` for the `kind_str` introspection; rewrite `kind_str` over `BinType`.
- [ ] **Agent `binops`**: `bin/split.rs` + `bin/concat.rs` — `objects` IndexMap→`entries` Vec, `Bin::builder()`→struct literal, dependency tracking→`linked`.
- [ ] **Lead**: `commands/project/project.rs` (reads only — small) + `src/bin/bin_roundtrip_test.rs` (update or delete `write_with_hashes` usage).

### Phase 2.2 — GATE + verify (LEAD)
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --lib --bins --tests -- -D warnings -A clippy::needless_return`. Fix per-file fallout (localized).
- [ ] Differential test `tests/diff_bin.rs`: for each `.bin` under `FLINT_TEST_ASSETS`, assert `ltk_ritobin::write_with_hashes(ltk_parse(d))` text == `rs_bin::to_text(rs_parse(d))` text (modulo known hash-resolution differences), AND `rs_bin` round-trip `from_text(to_text(b))` is stable. Skip if no fixtures.
- [ ] Commit per logical group.

## Agent rules (same as Plan 1)
No cargo commands (lead gates centrally). Edit only assigned files. Report `lib.rs`/`Cargo.toml` deltas. Preserve public fn signatures. Each agent reads its target file(s) + this translation table; the rs_bin source is at `e:/RitoShark/Flint/RitoShark-Crates/crates/rs_bin/src/` (`bin.rs` = types, `text/print.rs`+`text/parse.rs` = to_text/from_text).

## Risks
- **Hash width** in `to_text` (u32 bin hashes vs u64 HashMapper) — verify in Phase 2.0.
- **`ltk_meta::Bin` was serde-Serialize; `rs_bin::Bin` is not** — hence the `bin_json` shim.
- **`Bin.objects` (keyed map) → `entries` (Vec)** changes O(1) hash lookups to O(n) scans in split/concat — fine at these sizes; build a temp `HashMap<u32,usize>` if any hot loop needs it.
- Big interconnected diff — mitigated by core-first + the exhaustive table + final differential test.

## Self-Review
- **Coverage:** every file from the mapping (ltk_bridge, converter, refather, extractor, animation, champion_schema, dev, split, concat, project, bin_roundtrip_test) has a task. ✅
- **Type consistency:** `Bin/BinEntry/BinValue/BinType`, `fields`(not properties), `entries`(not objects), `linked`(not dependencies), `Pointer/Embed`(not Struct/Embedded), `List{is_list2}`(not Container/UnorderedContainer) — used consistently. ✅
- **No placeholders:** the translation table gives the concrete rs_bin form for every ltk pattern the mapping found. ✅
- **JSON:** addressed via Flint-side `bin_json` shim (BinValue not serde). ✅
