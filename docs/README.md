# docs

## Reference

- [ritobin-lsp.md](ritobin-lsp.md) — the optional ritobin language server: what it does, how it
  is kept away from your hashes, and how it is built and shipped with a Flint release.

## superpowers/

`specs/` and `plans/` are **dated records of a design at the time it was written**, not current
documentation. They are kept so the reasoning behind a decision survives, and they are not updated
when the code moves on. Read the date first, and check the code before trusting a detail.

Current architecture, format quirks and landmines live in `CLAUDE.md` at the repo root.

### Not shipped

- `2026-08-06-3d-editor-phase1-design.md` and its plan describe the mesh editor — submesh editing,
  cross-file geometry paste, weight painting, x-ray skeleton. That work is on the branch
  `feat/3d-editor-phase1` and has never been merged to `main`. Nothing it describes exists in a
  release: no `mesh/edit.rs`, no `ModelEditSession`, no `model-editor` window.
