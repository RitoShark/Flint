//! Resident bin-session registry. A session holds one parsed `Bin` tree, the
//! VFX edit index over it, and a bounded undo stack of entry-granular COW frames
//! (see [`super::undo`]). An edit clones only the top-level entries it touches.
//! Save writes the tree straight back to its file.

use super::model::{self, EditIndex, VfxModel};
use super::recolor::{self, ColorTargetSel, PaletteStop, RecolorOptions};
use super::undo::UndoFrame;
use crate::codec::{read_bin, write_bin, BinError, Result};
use parking_lot::RwLock;
use ritoshark::bin::Bin;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

pub type SessionId = u64;

const UNDO_CAP: usize = 50;

pub struct BinSession {
    pub id: SessionId,
    pub path: PathBuf,
    pub tree: Bin,
    pub index: EditIndex,
    /// True once an edit has changed the tree since open or the last save.
    pub dirty: bool,
    undo: Vec<UndoFrame>,
    redo: Vec<UndoFrame>,
}

impl BinSession {
    /// Reproject the edit index + view model. Called after a structural change
    /// (open, undo, redo). Edits that only change vec4/u8 values keep the index
    /// valid, so they don't need a reproject.
    fn reproject(&mut self) -> VfxModel {
        let (model, index) = model::project(&self.tree);
        self.index = index;
        model
    }

    /// Commit a completed edit's frame to the undo stack. A fresh edit
    /// invalidates the redo history.
    fn push_undo(&mut self, frame: UndoFrame) {
        if self.undo.len() >= UNDO_CAP {
            self.undo.remove(0);
        }
        self.undo.push(frame);
        self.redo.clear();
    }
}

static REGISTRY: OnceLock<RwLock<HashMap<SessionId, BinSession>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static RwLock<HashMap<SessionId, BinSession>> {
    REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Result of opening a file: the session id plus the initial VFX view.
pub struct OpenResult {
    pub session_id: SessionId,
    pub model: VfxModel,
}

/// Open a `.bin` into a resident session and register it.
pub fn open(path: impl AsRef<Path>) -> Result<OpenResult> {
    let path = path.as_ref().to_path_buf();
    let data = std::fs::read(&path)
        .map_err(|e| BinError(format!("Failed to read {}: {e}", path.display())))?;
    let tree = read_bin(&data)?;
    let (model, index) = model::project(&tree);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    registry().write().insert(
        id,
        BinSession {
            id,
            path,
            tree,
            index,
            dirty: false,
            undo: Vec::new(),
            redo: Vec::new(),
        },
    );
    Ok(OpenResult {
        session_id: id,
        model,
    })
}

/// Drop a session and free its tree. Returns false if the id was unknown.
pub fn close(id: SessionId) -> bool {
    registry().write().remove(&id).is_some()
}

fn with_session<R>(id: SessionId, f: impl FnOnce(&mut BinSession) -> R) -> Result<R> {
    let mut reg = registry().write();
    let session = reg
        .get_mut(&id)
        .ok_or_else(|| BinError(format!("No paint session with id {id}")))?;
    Ok(f(session))
}

/// The file a session is bound to (the caller needs it to resolve the project
/// root for a checkpoint).
pub fn path_of(id: SessionId) -> Result<PathBuf> {
    with_session(id, |s| s.path.clone())
}

/// Recolor selected emitters. Snapshots for undo, mutates the tree, returns the
/// count modified.
pub fn recolor_emitters(
    id: SessionId,
    emitter_keys: &[String],
    targets: &[ColorTargetSel],
    palette: &[PaletteStop],
    opts: &RecolorOptions,
) -> Result<usize> {
    with_session(id, |s| {
        // Every path a recolor can write lives under the selected emitters'
        // color targets — snapshot just those entries.
        let touched: Vec<usize> = emitter_keys
            .iter()
            .filter_map(|k| s.index.emitter_colors.get(k))
            .flat_map(|slots| slots.values())
            .flat_map(|t| t.constant.iter().chain(t.keyframes.iter()))
            .map(|p| p.entry)
            .collect();
        let frame = UndoFrame::capture(&s.tree, touched);
        let n = recolor::recolor_emitters(
            &mut s.tree,
            &s.index,
            emitter_keys,
            targets,
            palette,
            opts,
        );
        if n > 0 {
            s.dirty = true;
            s.push_undo(frame);
        }
        n
    })
}

/// Recolor a single material color param.
pub fn set_material_param(
    id: SessionId,
    selection_key: &str,
    new_color: [f32; 4],
    preserve_alpha: bool,
) -> Result<bool> {
    with_session(id, |s| {
        let Some(path) = s.index.material_params.get(selection_key).cloned() else {
            return false;
        };
        let frame = UndoFrame::capture(&s.tree, [path.entry]);
        let changed =
            recolor::recolor_material_param(&mut s.tree, &path, new_color, preserve_alpha, false);
        if changed {
            s.dirty = true;
            s.push_undo(frame);
        }
        changed
    })
}

/// Set an emitter's blend mode (the `blendMode: u8` node).
pub fn set_blend_mode(id: SessionId, emitter_key: &str, mode: u8) -> Result<bool> {
    with_session(id, |s| {
        let Some(path) = s.index.blend_modes.get(emitter_key).cloned() else {
            return false;
        };
        let frame = UndoFrame::capture(&s.tree, [path.entry]);
        let changed = match path.resolve_mut(&mut s.tree) {
            Some(ritoshark::bin::BinValue::U8(v)) => {
                if *v != mode {
                    *v = mode;
                    true
                } else {
                    false
                }
            }
            _ => false,
        };
        if changed {
            s.dirty = true;
            s.push_undo(frame);
        }
        changed
    })
}

/// Undo the last mutating edit. Returns the refreshed model, or `None` if the
/// undo stack was empty.
pub fn undo(id: SessionId) -> Result<Option<VfxModel>> {
    with_session(id, |s| match s.undo.pop() {
        Some(mut frame) => {
            // Swap the stored entries back in; the frame now holds the undone
            // state and parks on the redo stack.
            frame.swap_with(&mut s.tree);
            s.redo.push(frame);
            s.dirty = true;
            Some(s.reproject())
        }
        None => None,
    })
}

/// Redo the last undone edit. Returns the refreshed model, or `None` if there's
/// nothing to redo.
pub fn redo(id: SessionId) -> Result<Option<VfxModel>> {
    with_session(id, |s| match s.redo.pop() {
        Some(mut frame) => {
            frame.swap_with(&mut s.tree);
            if s.undo.len() >= UNDO_CAP {
                s.undo.remove(0);
            }
            s.undo.push(frame);
            s.dirty = true;
            Some(s.reproject())
        }
        None => None,
    })
}

/// Re-fetch the full VFX model (after edits, to refresh views).
pub fn model_of(id: SessionId) -> Result<VfxModel> {
    with_session(id, |s| {
        let (model, _) = model::project(&s.tree);
        model
    })
}

/// Refreshed color views for just `emitter_keys`, read from the live tree — the
/// partial payload a recolor returns instead of a whole-model reprojection
/// (O(selected emitters), not O(file)).
pub fn emitter_colors_of(
    id: SessionId,
    emitter_keys: &[String],
) -> Result<HashMap<String, model::EmitterColors>> {
    with_session(id, |s| {
        let mut out = HashMap::new();
        let BinSession { tree, index, .. } = s;
        // Clone the targets first: `emitter_colors_from_targets` needs `&mut
        // tree` while the index is borrowed from the same session.
        let wanted: Vec<(String, _)> = emitter_keys
            .iter()
            .filter_map(|k| index.emitter_colors.get(k).map(|s| (k.clone(), s.clone())))
            .collect();
        for (key, slots) in wanted {
            out.insert(key, model::emitter_colors_from_targets(tree, &slots));
        }
        out
    })
}

/// Is this session holding unsaved edits?
pub fn is_dirty(id: SessionId) -> Result<bool> {
    with_session(id, |s| s.dirty)
}

/// Serialize the session's tree to its file. Returns the path written, or
/// `None` when the session is clean (nothing to write).
pub fn save(id: SessionId) -> Result<Option<PathBuf>> {
    with_session(id, |s| -> Result<Option<PathBuf>> {
        if !s.dirty {
            return Ok(None);
        }
        let bytes = write_bin(&s.tree)?;
        std::fs::write(&s.path, bytes)
            .map_err(|e| BinError(format!("Failed to write {}: {e}", s.path.display())))?;
        s.dirty = false;
        Ok(Some(s.path.clone()))
    })?
}

/* Self-contained edit tests.
 *
 * These build their own bins on disk rather than needing a real skin, so they
 * always run. They cover the shapes a VFX colour actually takes — a bare vec4,
 * a `constantValue`, an animated `values` list, and the `dynamics`-nested form —
 * and assert that an edit reaches the BYTES, survives a save/reopen round-trip,
 * and replays byte-exact through undo/redo. */
#[cfg(test)]
mod edit_tests {
    use super::*;
    use crate::paint::fnv1a_lower as fh;
    use crate::paint::recolor::{ColorTargetSel, PaletteStop, RecolorMode, RecolorOptions};
    use indexmap::IndexMap;
    use ritoshark::bin::{Bin, BinEntry, BinType, BinValue};

    /// Colour field shapes a VfxEmitter can carry.
    enum ColorShape {
        /// `color: vec4 = {...}`
        BareVec4([f32; 4]),
        /// `color: embed = ValueColor { constantValue: vec4 }`
        Constant([f32; 4]),
        /// `ValueColor { values: list[vec4] }`
        Values(Vec<[f32; 4]>),
        /// `ValueColor { dynamics: pointer { values: list[vec4], times: list[f32] } }`
        Dynamics(Vec<[f32; 4]>),
        /// `ValueColor { constantValue: vec4, dynamics: { values, times } }` —
        /// both a constant AND keyframes, the case the editor lists together.
        ConstantPlusDynamics([f32; 4], Vec<[f32; 4]>),
    }

    fn vec4_list(items: &[[f32; 4]]) -> BinValue {
        BinValue::List {
            is_list2: false,
            item: BinType::Vec4,
            items: items.iter().map(|v| BinValue::Vec4(*v)).collect(),
        }
    }

    fn f32_list(n: usize) -> BinValue {
        BinValue::List {
            is_list2: false,
            item: BinType::F32,
            items: (0..n)
                .map(|i| {
                    BinValue::F32(if n <= 1 {
                        0.0
                    } else {
                        i as f32 / (n - 1) as f32
                    })
                })
                .collect(),
        }
    }

    fn color_field(shape: &ColorShape) -> BinValue {
        match shape {
            ColorShape::BareVec4(v) => BinValue::Vec4(*v),
            ColorShape::Constant(v) => {
                let mut f = IndexMap::new();
                f.insert(fh("constantValue"), BinValue::Vec4(*v));
                BinValue::Embed {
                    class: fh("ValueColor"),
                    fields: f,
                }
            }
            ColorShape::Values(vs) => {
                let mut f = IndexMap::new();
                f.insert(fh("values"), vec4_list(vs));
                f.insert(fh("times"), f32_list(vs.len()));
                BinValue::Embed {
                    class: fh("ValueColor"),
                    fields: f,
                }
            }
            ColorShape::Dynamics(vs) => {
                let mut inner = IndexMap::new();
                inner.insert(fh("values"), vec4_list(vs));
                inner.insert(fh("times"), f32_list(vs.len()));
                let mut f = IndexMap::new();
                f.insert(
                    fh("dynamics"),
                    BinValue::Pointer {
                        class: fh("VfxAnimatedColorVariableData"),
                        fields: inner,
                    },
                );
                BinValue::Embed {
                    class: fh("ValueColor"),
                    fields: f,
                }
            }
            ColorShape::ConstantPlusDynamics(c, vs) => {
                let mut inner = IndexMap::new();
                inner.insert(fh("values"), vec4_list(vs));
                inner.insert(fh("times"), f32_list(vs.len()));
                let mut f = IndexMap::new();
                f.insert(fh("constantValue"), BinValue::Vec4(*c));
                f.insert(
                    fh("dynamics"),
                    BinValue::Pointer {
                        class: fh("VfxAnimatedColorVariableData"),
                        fields: inner,
                    },
                );
                BinValue::Embed {
                    class: fh("ValueColor"),
                    fields: f,
                }
            }
        }
    }

    /// One system, one complex emitter, with `color` set to `shape`.
    fn bin_with_color(shape: ColorShape) -> Bin {
        let mut emitter = IndexMap::new();
        emitter.insert(fh("emitterName"), BinValue::String("Test".into()));
        emitter.insert(fh("blendMode"), BinValue::U8(1));
        emitter.insert(fh("color"), color_field(&shape));

        let mut sys = IndexMap::new();
        sys.insert(fh("particleName"), BinValue::String("TestSystem".into()));
        sys.insert(
            fh("complexEmitterDefinitionData"),
            BinValue::List {
                is_list2: false,
                item: BinType::Embed,
                items: vec![BinValue::Embed {
                    class: fh("VfxEmitterDefinitionData"),
                    fields: emitter,
                }],
            },
        );

        let mut bin = Bin::new();
        bin.version = 3;
        bin.entries.push(BinEntry {
            path_hash: 0x1234_5678,
            class_hash: fh("VfxSystemDefinitionData"),
            fields: sys,
        });
        bin
    }

    fn write_temp(bin: &Bin, name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("flint-paint-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}-{}.bin", name, std::process::id()));
        std::fs::write(&path, write_bin(bin).unwrap()).unwrap();
        path
    }

    fn only_emitter_key(id: SessionId) -> String {
        with_session(id, |s| {
            s.index
                .emitter_colors
                .keys()
                .next()
                .cloned()
                .expect("emitter should have a colour target")
        })
        .unwrap()
    }

    fn session_bytes(id: SessionId) -> Vec<u8> {
        with_session(id, |s| write_bin(&s.tree).unwrap()).unwrap()
    }

    fn colors_of(id: SessionId, key: &str) -> Vec<[f32; 4]> {
        with_session(id, |s| {
            let m = s.reproject();
            m.emitters
                .iter()
                .find(|e| e.key == key)
                .and_then(|e| e.colors.color.as_ref())
                .map(|c| c.keyframes.iter().map(|k| k.rgba).collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .unwrap()
    }

    fn recolor_opts(preserve_alpha: bool) -> RecolorOptions {
        RecolorOptions {
            mode: RecolorMode::Linear,
            ignore_black_white: false,
            preserve_alpha,
            hsl_shift: (0.0, 0.0, 0.0),
            hue_target: None,
            seed: 7,
        }
    }

    fn two_stop_palette() -> Vec<PaletteStop> {
        vec![
            PaletteStop {
                vec4: [1.0, 0.0, 0.0, 1.0],
                time: 0.0,
            },
            PaletteStop {
                vec4: [0.0, 0.0, 1.0, 1.0],
                time: 1.0,
            },
        ]
    }

    /// A recolor must reach every keyframe, for EVERY colour shape — the bug
    /// being guarded here is a writer that only understands one of them and
    /// silently no-ops on the rest.
    #[test]
    fn recolor_writes_every_color_shape() {
        let cases: Vec<(&str, ColorShape, usize)> = vec![
            ("bare_vec4", ColorShape::BareVec4([0.9, 0.1, 0.1, 1.0]), 1),
            ("constant", ColorShape::Constant([0.9, 0.1, 0.1, 1.0]), 1),
            (
                "values",
                ColorShape::Values(vec![[0.9, 0.1, 0.1, 1.0], [0.1, 0.9, 0.1, 1.0]]),
                2,
            ),
            (
                "dynamics",
                ColorShape::Dynamics(vec![
                    [0.9, 0.1, 0.1, 1.0],
                    [0.1, 0.9, 0.1, 1.0],
                    [0.1, 0.1, 0.9, 1.0],
                ]),
                3,
            ),
            (
                "constant_plus_dynamics",
                ColorShape::ConstantPlusDynamics(
                    [0.7, 0.7, 0.2, 1.0],
                    vec![[0.9, 0.1, 0.1, 1.0], [0.1, 0.9, 0.1, 1.0]],
                ),
                3,
            ),
        ];

        for (name, shape, expected_kfs) in cases {
            let path = write_temp(&bin_with_color(shape), name);
            let id = open(&path).unwrap().session_id;
            let key = only_emitter_key(id);

            let before = colors_of(id, &key);
            assert_eq!(
                before.len(),
                expected_kfs,
                "{name}: editor should list {expected_kfs} keyframe(s)"
            );

            let n = recolor_emitters(
                id,
                &[key.clone()],
                &[ColorTargetSel::All],
                &two_stop_palette(),
                &recolor_opts(true),
            )
            .unwrap();
            assert!(n > 0, "{name}: recolor reported no change");

            let after = colors_of(id, &key);
            assert_ne!(before, after, "{name}: recolor did not reach the values");
            close(id);
            let _ = std::fs::remove_file(&path);
        }
    }

    /// The edit must survive save + reopen. This is the "it didn't save" report:
    /// an in-memory change that never reaches the file looks fine until reload.
    #[test]
    fn recolor_survives_save_and_reopen() {
        let path = write_temp(
            &bin_with_color(ColorShape::Dynamics(vec![
                [0.9, 0.9, 0.9, 1.0],
                [0.5, 0.5, 0.5, 1.0],
            ])),
            "recolor_roundtrip",
        );
        let id = open(&path).unwrap().session_id;
        let key = only_emitter_key(id);
        let before = colors_of(id, &key);

        recolor_emitters(
            id,
            &[key.clone()],
            &[ColorTargetSel::All],
            &two_stop_palette(),
            &recolor_opts(true),
        )
        .unwrap();
        let written = save(id).unwrap();
        assert!(written.is_some(), "the dirty bin should be written");
        close(id);

        let id2 = open(&path).unwrap().session_id;
        let key2 = only_emitter_key(id2);
        let after = colors_of(id2, &key2);
        assert_ne!(before, after, "recolor did not persist to disk");
        close(id2);
        let _ = std::fs::remove_file(&path);
    }

    /// `preserve_alpha` must leave a non-1.0 alpha untouched while RGB changes.
    #[test]
    fn recolor_preserve_alpha_keeps_alpha() {
        let path = write_temp(
            &bin_with_color(ColorShape::Values(vec![
                [0.9, 0.9, 0.9, 0.25],
                [0.5, 0.5, 0.5, 0.75],
            ])),
            "recolor_alpha",
        );
        let id = open(&path).unwrap().session_id;
        let key = only_emitter_key(id);

        recolor_emitters(
            id,
            &[key.clone()],
            &[ColorTargetSel::All],
            &two_stop_palette(),
            &recolor_opts(true),
        )
        .unwrap();

        let after = colors_of(id, &key);
        assert!((after[0][3] - 0.25).abs() < 1e-6, "alpha 0 lost: {after:?}");
        assert!((after[1][3] - 0.75).abs() < 1e-6, "alpha 1 lost: {after:?}");
        close(id);
        let _ = std::fs::remove_file(&path);
    }

    /// Recolor undo/redo replays byte-exact.
    #[test]
    fn recolor_undo_redo_is_byte_exact() {
        let path = write_temp(
            &bin_with_color(ColorShape::Dynamics(vec![
                [0.9, 0.9, 0.9, 1.0],
                [0.2, 0.4, 0.6, 1.0],
            ])),
            "recolor_undo",
        );
        let id = open(&path).unwrap().session_id;
        let key = only_emitter_key(id);

        let s0 = session_bytes(id);
        recolor_emitters(
            id,
            &[key.clone()],
            &[ColorTargetSel::All],
            &two_stop_palette(),
            &recolor_opts(true),
        )
        .unwrap();
        let s1 = session_bytes(id);
        assert_ne!(s0, s1, "recolor did not change the bytes");

        undo(id).unwrap().unwrap();
        assert_eq!(session_bytes(id), s0, "recolor undo was not byte-exact");
        redo(id).unwrap().unwrap();
        assert_eq!(session_bytes(id), s1, "recolor redo was not byte-exact");
        close(id);
        let _ = std::fs::remove_file(&path);
    }

    /// A blend-mode edit and a recolor must both persist — interleaving two
    /// different edit kinds is where entry-granular undo frames can collide.
    #[test]
    fn blend_mode_then_recolor_both_persist() {
        let path = write_temp(
            &bin_with_color(ColorShape::Dynamics(vec![
                [0.9, 0.9, 0.9, 1.0],
                [0.2, 0.4, 0.6, 1.0],
            ])),
            "blend_then_recolor",
        );
        let id = open(&path).unwrap().session_id;
        let key = only_emitter_key(id);

        assert!(set_blend_mode(id, &key, 4).unwrap());
        let after_blend = session_bytes(id);

        recolor_emitters(
            id,
            &[key.clone()],
            &[ColorTargetSel::All],
            &two_stop_palette(),
            &recolor_opts(true),
        )
        .unwrap();

        // The blend mode must have survived the recolor.
        let bm = with_session(id, |s| {
            let m = s.reproject();
            m.emitters.iter().find(|e| e.key == key).unwrap().blend_mode
        })
        .unwrap();
        assert_eq!(bm, 4, "recolor clobbered the blend mode");

        undo(id).unwrap().unwrap();
        assert_eq!(
            session_bytes(id),
            after_blend,
            "undo of recolor did not return to the post-blend state"
        );
        close(id);
        let _ = std::fs::remove_file(&path);
    }

    /// A no-op edit must report "nothing changed" rather than dirtying the
    /// session and pushing an empty undo step.
    #[test]
    fn same_blend_mode_is_a_noop() {
        let path = write_temp(
            &bin_with_color(ColorShape::Constant([0.9, 0.1, 0.1, 1.0])),
            "blend_noop",
        );
        let id = open(&path).unwrap().session_id;
        let key = only_emitter_key(id);

        let before = session_bytes(id);
        // The fixture's blendMode is already 1.
        assert!(!set_blend_mode(id, &key, 1).unwrap());
        assert_eq!(before, session_bytes(id), "no-op still mutated the bytes");
        assert!(!is_dirty(id).unwrap(), "no-op marked the session dirty");
        assert!(undo(id).unwrap().is_none(), "no-op pushed an undo frame");
        close(id);
        let _ = std::fs::remove_file(&path);
    }

    /// Saving with nothing dirty must not rewrite the file.
    #[test]
    fn save_with_no_changes_writes_nothing() {
        let path = write_temp(
            &bin_with_color(ColorShape::Constant([0.9, 0.1, 0.1, 1.0])),
            "save_clean",
        );
        let id = open(&path).unwrap().session_id;
        assert!(save(id).unwrap().is_none(), "clean session wrote a file");
        close(id);
        let _ = std::fs::remove_file(&path);
    }

    /// Undo back to pristine then save must restore the original file bytes.
    #[test]
    fn undo_then_save_restores_original_bytes() {
        let bin = bin_with_color(ColorShape::Values(vec![
            [0.9, 0.1, 0.1, 1.0],
            [0.1, 0.9, 0.1, 1.0],
        ]));
        let original = write_bin(&bin).unwrap();
        let path = write_temp(&bin, "undo_save");

        let id = open(&path).unwrap().session_id;
        let key = only_emitter_key(id);
        recolor_emitters(
            id,
            &[key],
            &[ColorTargetSel::All],
            &two_stop_palette(),
            &recolor_opts(true),
        )
        .unwrap();
        undo(id).unwrap().unwrap();
        save(id).unwrap();
        close(id);

        let on_disk = std::fs::read(&path).unwrap();
        assert_eq!(
            on_disk, original,
            "undo + save did not restore the original file bytes"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A material param edit reaches the bytes and undoes cleanly.
    #[test]
    fn material_param_edit_round_trips() {
        let mut param = IndexMap::new();
        param.insert(fh("name"), BinValue::String("Color1".into()));
        param.insert(fh("value"), BinValue::Vec4([1.0, 0.5, 0.0, 1.0]));
        let mut mat = IndexMap::new();
        mat.insert(
            fh("paramValues"),
            BinValue::List {
                is_list2: false,
                item: BinType::Embed,
                items: vec![BinValue::Embed {
                    class: fh("StaticMaterialShaderParamDef"),
                    fields: param,
                }],
            },
        );
        let mut bin = Bin::new();
        bin.version = 3;
        bin.entries.push(BinEntry {
            path_hash: 0xABCD_0001,
            class_hash: fh("StaticMaterialDef"),
            fields: mat,
        });
        let path = write_temp(&bin, "material_param");

        let id = open(&path).unwrap().session_id;
        let sel = with_session(id, |s| {
            s.index.material_params.keys().next().cloned().unwrap()
        })
        .unwrap();

        let s0 = session_bytes(id);
        assert!(set_material_param(id, &sel, [0.0, 0.2, 0.9, 1.0], true).unwrap());
        let s1 = session_bytes(id);
        assert_ne!(s0, s1, "material param edit did not reach the bytes");

        undo(id).unwrap().unwrap();
        assert_eq!(session_bytes(id), s0, "material undo was not byte-exact");
        close(id);
        let _ = std::fs::remove_file(&path);
    }
}
