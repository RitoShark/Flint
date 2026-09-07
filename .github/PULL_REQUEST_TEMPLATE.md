## What this changes

<!-- One or two lines. If it fixes an issue, put "Fixes #123" here. -->

## Why

<!-- Skip if it is obvious from the above. -->

## Checked

- [ ] `npx tsc --noEmit` passes
- [ ] `cargo clippy` passes from `src-tauri/`
- [ ] Ran it in the app and the change actually works
- [ ] Commit messages follow Conventional Commits

<!--
Do not run `cargo build` or `cargo check` on their own. `npm run tauri dev` compiles the Rust
itself, and a standalone build wipes the incremental cache and costs you a 15 minute rebuild.
-->
