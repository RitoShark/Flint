use crate::bin::{read_bin, write_bin, Bin, BinEntry, BinValue, Trailer};
use ritoshark::hash::{fnv1a, xxh64};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

#[derive(Clone, Default)]
struct Context {
    model: bool,
    submesh: bool,
    vfx: bool,
    folder: Option<String>,
    label: Option<String>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Placement {
    priority: u8,
    folder: String,
    label: String,
}

pub fn organize(wad: &Path, fallback: &str) -> Result<Trailer, String> {
    let mut paths = BTreeMap::new();
    let mut sources = BTreeMap::new();
    let mut bin_paths = Vec::new();
    for entry in WalkDir::new(wad).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(wad)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        paths.insert(xxh64(&relative), relative);
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        if stem.len() == 16 {
            if let Ok(hash) = u64::from_str_radix(&stem, 16) {
                sources.insert(hash, path.to_path_buf());
            }
        }
        if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("bin"))
        {
            bin_paths.push(path.to_path_buf());
        }
    }
    if sources.is_empty() {
        return Ok(Trailer::new());
    }
    bin_paths.sort();
    let mut bins = Vec::with_capacity(bin_paths.len());
    for path in bin_paths {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let bin = read_bin(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        bins.push((path, bin));
    }
    let entries: HashMap<u32, &BinEntry> = bins
        .iter()
        .flat_map(|(_, bin)| bin.entries.iter().map(|e| (e.path_hash, e)))
        .collect();
    let mut placements = BTreeMap::new();
    for (_, bin) in &bins {
        for entry in &bin.entries {
            let context = Context {
                vfx: entry.class_hash == fnv1a("VfxSystemDefinitionData"),
                ..Default::default()
            };
            for value in entry.fields.values() {
                visit(
                    value,
                    &context,
                    &paths,
                    &sources,
                    &entries,
                    &mut HashSet::new(),
                    fallback,
                    &mut placements,
                );
            }
        }
    }
    let mut names = Trailer::new();
    let mut replacements = BTreeMap::new();
    let mut copies = Vec::new();
    let mut occupied: HashSet<String> = paths.values().map(|p| p.to_ascii_lowercase()).collect();
    for (hash, placement) in placements {
        let source = &sources[&hash];
        let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("ltk");
        let base = if placement.priority < 2 {
            format!("{}_hashed", safe_name(&placement.label))
        } else {
            format!("hashed_vfx_{hash:016x}")
        };
        let mut relative = format!("{}/{}.{}", placement.folder, base, ext);
        if occupied.contains(&relative.to_ascii_lowercase()) {
            relative = format!("{}/{}_{hash:016x}.{}", placement.folder, base, ext);
        }
        let mut suffix = 2;
        while occupied.contains(&relative.to_ascii_lowercase()) {
            relative = format!("{}/{}_{hash:016x}_{suffix}.{}", placement.folder, base, ext);
            suffix += 1;
        }
        if !safe_relative(&relative) {
            return Err(format!("Unsafe recovered asset path: {relative}"));
        }
        occupied.insert(relative.to_ascii_lowercase());
        replacements.insert(hash, xxh64(&relative));
        names.files.insert(xxh64(&relative), relative.clone());
        copies.push((source.clone(), wad.join(relative)));
    }
    let mut writes = Vec::new();
    for (path, mut bin) in bins {
        let mut changed = false;
        for entry in &mut bin.entries {
            for value in entry.fields.values_mut() {
                changed |= rewrite(value, &replacements);
            }
        }
        if changed {
            let destination = copies
                .iter()
                .find(|(source, _)| *source == path)
                .map(|(_, dest)| dest.clone())
                .unwrap_or(path);
            writes.push((destination, write_bin(&bin).map_err(|e| e.to_string())?));
        }
    }
    for (source, destination) in &copies {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
    }
    for (path, bytes) in writes {
        fs::write(path, bytes).map_err(|e| e.to_string())?;
    }
    for (source, _) in copies {
        fs::remove_file(source).map_err(|e| e.to_string())?;
    }
    crate::bin::names::forget_mod_root(wad);
    Ok(names)
}

fn safe_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    if name.is_empty() {
        "model".into()
    } else {
        name
    }
}

fn safe_relative(path: &str) -> bool {
    !path.starts_with('/')
        && !path.contains(':')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn path_of(value: &BinValue, paths: &BTreeMap<u64, String>) -> Option<String> {
    match value {
        BinValue::String(s) => Some(s.replace('\\', "/")),
        BinValue::File(hash) => paths.get(hash).cloned(),
        _ => None,
    }
}

fn visit(
    value: &BinValue,
    context: &Context,
    paths: &BTreeMap<u64, String>,
    sources: &BTreeMap<u64, PathBuf>,
    entries: &HashMap<u32, &BinEntry>,
    visiting: &mut HashSet<u32>,
    fallback: &str,
    out: &mut BTreeMap<u64, Placement>,
) {
    match value {
        BinValue::File(hash) if sources.contains_key(hash) && (context.model || context.vfx) => {
            let placement = Placement {
                priority: if context.submesh {
                    0
                } else if context.model {
                    1
                } else {
                    2
                },
                folder: if context.model {
                    context.folder.clone().unwrap_or_else(|| fallback.into())
                } else {
                    format!("{fallback}/particles/hashed_vfx")
                },
                label: context.label.clone().unwrap_or_else(|| "model".into()),
            };
            if out.get(hash).is_none_or(|existing| placement < *existing) {
                out.insert(*hash, placement);
            }
        }
        BinValue::Embed { class, fields } | BinValue::Pointer { class, fields } => {
            let mut context = context.clone();
            if *class == fnv1a("VfxSystemDefinitionData") {
                context.vfx = true;
            }
            if *class == fnv1a("SkinMeshDataProperties") {
                context.model = true;
                if let Some(path) = fields
                    .get(&fnv1a("simpleSkin"))
                    .and_then(|v| path_of(v, paths))
                {
                    context.folder = path.rsplit_once('/').map(|(folder, _)| folder.to_string());
                    context.label = Path::new(&path)
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned());
                }
            }
            if *class == fnv1a("SkinMeshDataProperties_MaterialOverride") {
                context.model = true;
                context.submesh = true;
                if let Some(BinValue::String(submesh)) = fields.get(&fnv1a("submesh")) {
                    context.label = Some(submesh.clone());
                }
            }
            for value in fields.values() {
                visit(
                    value, &context, paths, sources, entries, visiting, fallback, out,
                );
            }
        }
        BinValue::Link(hash) | BinValue::Hash(hash)
            if (context.model || context.vfx) && visiting.insert(*hash) =>
        {
            if let Some(entry) = entries.get(hash) {
                for value in entry.fields.values() {
                    visit(
                        value, context, paths, sources, entries, visiting, fallback, out,
                    );
                }
            }
            visiting.remove(hash);
        }
        BinValue::List { items, .. } => {
            for value in items {
                visit(
                    value, context, paths, sources, entries, visiting, fallback, out,
                );
            }
        }
        BinValue::Option {
            value: Some(value), ..
        } => visit(
            value, context, paths, sources, entries, visiting, fallback, out,
        ),
        BinValue::Map {
            entries: values, ..
        } => {
            for (key, value) in values {
                visit(
                    key, context, paths, sources, entries, visiting, fallback, out,
                );
                visit(
                    value, context, paths, sources, entries, visiting, fallback, out,
                );
            }
        }
        _ => {}
    }
}

fn rewrite(value: &mut BinValue, replacements: &BTreeMap<u64, u64>) -> bool {
    match value {
        BinValue::File(hash) => {
            if let Some(replacement) = replacements.get(hash) {
                *hash = *replacement;
                true
            } else {
                false
            }
        }
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => fields
            .values_mut()
            .fold(false, |changed, v| rewrite(v, replacements) || changed),
        BinValue::List { items, .. } => items
            .iter_mut()
            .fold(false, |changed, v| rewrite(v, replacements) || changed),
        BinValue::Option {
            value: Some(value), ..
        } => rewrite(value, replacements),
        BinValue::Map { entries, .. } => entries.iter_mut().fold(false, |changed, (k, v)| {
            let key = rewrite(k, replacements);
            rewrite(v, replacements) || key || changed
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bin::BinType;

    fn fixture(root: &Path) -> u64 {
        let shared = 0xc49cec28a66ae5bb;
        let model = "assets/sirdexal/lml-kayn/kayn.skn";
        fs::create_dir_all(root.join("assets/sirdexal/lml-kayn")).unwrap();
        fs::write(root.join(model), b"model").unwrap();
        fs::write(root.join(format!("{shared:016x}.tex")), b"shared texture").unwrap();
        fs::write(root.join("0000000000000042.tex"), b"particle texture").unwrap();
        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: 1,
            class_hash: fnv1a("VfxSystemDefinitionData"),
            fields: [(1, BinValue::File(shared)), (2, BinValue::File(0x42))]
                .into_iter()
                .collect(),
        });
        bin.entries.push(BinEntry {
            path_hash: 2,
            class_hash: fnv1a("SkinCharacterDataProperties"),
            fields: [(
                fnv1a("skinMeshProperties"),
                BinValue::Embed {
                    class: fnv1a("SkinMeshDataProperties"),
                    fields: [
                        (fnv1a("simpleSkin"), BinValue::File(xxh64(model))),
                        (
                            fnv1a("materialOverride"),
                            BinValue::List {
                                is_list2: false,
                                item: BinType::Embed,
                                items: vec![BinValue::Embed {
                                    class: fnv1a("SkinMeshDataProperties_MaterialOverride"),
                                    fields: [
                                        (fnv1a("texture"), BinValue::File(shared)),
                                        (
                                            fnv1a("Submesh"),
                                            BinValue::String("Recall_Basketballnet".into()),
                                        ),
                                    ]
                                    .into_iter()
                                    .collect(),
                                }],
                            },
                        ),
                    ]
                    .into_iter()
                    .collect(),
                },
            )]
            .into_iter()
            .collect(),
        });
        fs::write(root.join("skin.bin"), write_bin(&bin).unwrap()).unwrap();
        shared
    }

    #[test]
    fn model_overrides_win_shared_hashes_and_particle_only_files_get_their_own_folder() {
        let dir = tempfile::tempdir().unwrap();
        let old = fixture(dir.path());
        let names = organize(dir.path(), "assets/sirdexal/lml-kayn").unwrap();
        let model = "assets/sirdexal/lml-kayn/Recall_Basketballnet_hashed.tex";
        let vfx = "assets/sirdexal/lml-kayn/particles/hashed_vfx/hashed_vfx_0000000000000042.tex";
        assert_eq!(fs::read(dir.path().join(model)).unwrap(), b"shared texture");
        assert_eq!(fs::read(dir.path().join(vfx)).unwrap(), b"particle texture");
        assert_eq!(names.files[&xxh64(model)], model);
        let bin = read_bin(&fs::read(dir.path().join("skin.bin")).unwrap()).unwrap();
        assert_eq!(bin.entries[0].fields[&1], BinValue::File(xxh64(model)));
        assert_eq!(bin.entries[0].fields[&2], BinValue::File(xxh64(vfx)));
        assert!(!dir.path().join(format!("{old:016x}.tex")).exists());
        assert!(organize(dir.path(), "assets/sirdexal/lml-kayn")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn colliding_names_do_not_replace_existing_assets() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let occupied = dir
            .path()
            .join("assets/sirdexal/lml-kayn/Recall_Basketballnet_hashed.tex");
        fs::write(&occupied, b"existing asset").unwrap();
        let names = organize(dir.path(), "assets/sirdexal/lml-kayn").unwrap();
        assert_eq!(fs::read(occupied).unwrap(), b"existing asset");
        assert!(names
            .files
            .values()
            .any(|p| p.ends_with("Recall_Basketballnet_hashed_c49cec28a66ae5bb.tex")));
    }

    #[test]
    fn names_cannot_escape_the_project() {
        assert_eq!(
            safe_name("../Recall:Basketball/net"),
            "___Recall_Basketball_net"
        );
        for path in [
            "../escaped.tex",
            "C:/escape.tex",
            "/escape.tex",
            "assets/../escape.tex",
        ] {
            assert!(!safe_relative(path));
        }
        assert!(safe_relative(
            "assets/custom/Recall_Basketballnet_hashed.tex"
        ));
    }
}
