//! Entry-granular copy-on-write undo frames for the paint session.
//!
//! Cloning the whole `Bin` tree per edit makes every recolor click O(file),
//! which is the dominant cost on a large skin bin. No paint op adds or removes
//! a *top-level* entry (every edit is value-only), so an edit can snapshot just
//! the top-level entries its paths touch.
//!
//! A frame stores those entries as they stood on the OTHER side of the edit,
//! and undo/redo is a `mem::swap` against the live tree: after an undo the same
//! frame holds the "after" state, ready for redo. Undo and redo are therefore
//! exact inverses by construction — the restored entries are bit-identical
//! clones, not replayed operations.

use ritoshark::bin::{Bin, BinEntry};

/// One reversible edit frame on the undo/redo stacks.
pub struct UndoFrame {
    /// The touched top-level entries (sorted, deduped) from the other side of
    /// the swap.
    entries: Vec<(usize, BinEntry)>,
}

impl UndoFrame {
    /// Snapshot the entries at `touched` indices out of `tree`. Out-of-range
    /// indices are skipped — an edit addressing one fails without mutating, so
    /// there is nothing to restore for it.
    pub fn capture(tree: &Bin, touched: impl IntoIterator<Item = usize>) -> UndoFrame {
        let mut idxs: Vec<usize> = touched
            .into_iter()
            .filter(|&i| i < tree.entries.len())
            .collect();
        idxs.sort_unstable();
        idxs.dedup();
        UndoFrame {
            entries: idxs
                .into_iter()
                .map(|i| (i, tree.entries[i].clone()))
                .collect(),
        }
    }

    /// True when the frame captured nothing, so pushing it would add a
    /// no-op step to the undo stack.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Swap the stored state with the live tree. Symmetric: calling it twice is
    /// a no-op, so the same frame serves undo and redo as it moves between
    /// stacks.
    pub fn swap_with(&mut self, tree: &mut Bin) {
        for (idx, stored) in self.entries.iter_mut() {
            if let Some(live) = tree.entries.get_mut(*idx) {
                std::mem::swap(stored, live);
            }
        }
    }
}
