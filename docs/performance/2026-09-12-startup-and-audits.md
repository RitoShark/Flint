# Startup and project audit performance

The baseline is Flint `10911774`, built with the same installed dependencies and Vite 5.4.21 as the updated frontend.

## Startup

| Production welcome-screen JavaScript | Bytes |
| --- | ---: |
| Baseline | 12,587,158 |
| Updated | 1,337,230 |
| Reduction | 11,249,928 (89.4%) |

Window roots, editor views, browsers and modals now load on demand. Workspace search also loads on demand: its Monaco import previously reached the welcome screen through the project file tree. Project previews use the existing lazy model viewer and forward animation selection and autoplay through the same prop type.

The native startup-ready signal remains inside the root Suspense boundary with the application. Loading a feature displays a shared loading indicator. Modal components remain mounted for their existing exit animations.

Rollup initially placed Vite's shared preload helper in the manually named Monaco chunk. That made even the lazy entry point import Monaco. Giving the helper its own small chunk removes this generated dependency; checking source imports alone missed it.

Reproduce the production welcome-screen JavaScript measurement:

```sh
npm run build -- --manifest
node scripts/measure-startup.mjs
```

The script sums emitted JavaScript bytes for the entry and the App chunk, including their transitive static imports once each. App must be included even though its window root loads dynamically. CSS, workers and optional feature loads are excluded. These are uncompressed file sizes, not download timings or native launch-time measurements. First use of an editor or studio loads its deferred chunks; subsequent uses reuse loaded modules.

## Project audits

Both full project audits and single-file texture rechecks now read at most 148 bytes per texture instead of allocating and reading the complete file. This covers the DDS header and DX10 extension as well as TEX headers. The existing header parser and findings are unchanged.

For a 4 MiB texture, the requested data falls from 4,194,304 bytes to 148 bytes. Filesystem caching and read granularity affect physical disk traffic, so this is an application read bound rather than a disk throughput benchmark.

Regression tests compare complete serialized findings with the previous full-buffer checks across TEX/DDS extension mismatches, truncated headers and DX10 data. They also verify the bytes consumed and agreement between individual checks and a folder audit.

## References

Jade's local startup and map-loading code were inspected alongside Flint's existing map optimizations. LTK Manager's remote branches were enumerated and cloned locally for reference. Its current `main` (`a81b82a`) defers the workshop module at the root and supports bounded header reads in the problem scanner. The `feat/home-page` branch (`486f97d`) was also checked; its older root eagerly imports more features. These patterns informed the review; no new LTK dependencies were added.

## Validation

- Production build, TypeScript compilation and UI checks pass.
- An isolated headless Chrome run with mocked Tauri IPC renders the welcome screen and completes the startup-ready handshake. The New Project modal opens and closes after its deferred import. No uncaught runtime exceptions occur, and startup resource requests contain neither Monaco nor the large 3D engine chunk.
- Frontend: 71 test files, 614 tests pass.
- Rust: `cargo test -p flint-bin --lib`, 119 tests pass.
- `cargo clippy -p flint-bin --lib -- -D warnings` passes.
- Strict Clippy with `--all-targets` reports five existing `cloned_ref_to_slice_refs` warnings in `paint/session.rs` tests, outside the changed audit code.

Native cold-launch time, interactive frame rate and end-to-end project audit duration have not been benchmarked in this pass.
