# Flint documentation

Start here for the current project format, editing workflow, and CDN behavior. These guides describe the implementation in this checkout; dated design records below are historical context.

## Core guides

| Guide | What it explains |
|---|---|
| [How Flint works](architecture.md) | Data flow, frontend/backend responsibilities, persistent files, and core operations. |
| [Working with projects](projects.md) | Project folders, creation, repathing, layers, imports, checkpoints and export. |
| [`flint.json` reference](flint-json.md) | Every schema 2 field, defaults, examples, legacy migration and the distinction from application settings. |
| [Getting files from the CDN](cdn.md) | Download individual assets without an install, unpack WADs, save raw archives, and understand manifests/caches. |
| [Files, hashes and references](formats-and-references.md) | Common formats, dependencies, readable hash names and why paths must match. |

For your first project, read [Working with projects](projects.md). If you only need files from a patch, go directly to [Download only a few assets](cdn.md#download-only-a-few-assets).

## Reference

- [ritobin-lsp.md](ritobin-lsp.md) — the optional ritobin language server: what it does, how it
  is kept away from your hashes, and how it is built and shipped with a Flint release.

## superpowers/

`specs/` and `plans/` are **dated records of a design at the time it was written**, not current
documentation. They are kept so the reasoning behind a decision survives, and they are not updated
when the code moves on. Read the date first, and check the code before trusting a detail.

The core guides above explain the current workflows and link to their implementation. Local maintainer notes may contain additional development details.

### Not shipped

- `2026-08-06-3d-editor-phase1-design.md` and its plan describe the mesh editor — submesh editing,
  cross-file geometry paste, weight painting, x-ray skeleton. That work is on the branch
  `feat/3d-editor-phase1` and has never been merged to `main`. Nothing it describes exists in a
  release: no `mesh/edit.rs`, no `ModelEditSession`, no `model-editor` window.
