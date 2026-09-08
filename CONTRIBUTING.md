# Contributing

PRs are welcome. Nothing here is strict except the commit format, which the changelog depends on.

## Getting it running

Needs Rust (stable), Node 20, and Windows 10 or 11.

```bash
git clone https://github.com/RitoShark/Flint
cd Flint
npm install
npm run tauri dev
```

## Before you push

```bash
npx tsc --noEmit          # frontend types
cd src-tauri && cargo clippy
```

## Commits

[Conventional Commits](https://www.conventionalcommits.org), because
[git-cliff](cliff.toml) builds the changelog from them.

```
feat(wad-explorer): keyboard navigation in the tree
fix(export): keep folder-form WADs as folders
```

Types that show up in the changelog: `feat`, `fix`, `perf`, `refactor`, `doc`.
`chore` and `ci` are skipped. Scope is optional.

Keep commits small and focused. One commit per finished piece of work beats one big one at the end.

## Code style

Match the file you are in. Two things are not negotiable:

**No comments.** Zero by default. Naming and structure carry it. The exception is a real landmine,
meaning a non-obvious trap where the next person breaks something without the warning: a format
quirk, an ordering requirement, a platform bug. Keep that to one line. Comments go stale the moment
the code moves and a comment that lies is worse than none.

**Format work belongs in the library.** If Flint needs a new format capability, or a format bug
fixed, it goes in [RitoShark-Crates](https://github.com/RitoShark/RitoShark-Crates), not into a
workaround here. Open an issue first so the change lands in the right place.

## Things worth knowing

- WAD chunk path hashes are `xxh64` of the **lowercased** path, seed 0. Lowercase before hashing or
  the chunk will not resolve.
- BIN field, class and entry names are FNV1a-32 of the lowercased name.
- A `.dds` may only carry BC1, BC3 or BGRA8. BC5 and BC7 have no D3D9 pixel format, so every writer
  falls through to the DX10 header, and League's loader reads the pixels 20 bytes short and crashes
  the client. Reading a DX10 BC7 `.dds` is fine, writing one is not.
- Never commit game assets. Test fixtures with real game data are gitignored.
