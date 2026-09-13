# Default BIN schema checks

Flint's default saved-file checks and **Check files** audits now compare declared
BIN property types with the JSON release dump from
[LeagueToolkit/lol-meta-classes](https://github.com/LeagueToolkit/lol-meta-classes/releases).
This is the same metadata source used by ritobin-lsp's `meta_wiki` service; Flint
does not scrape rendered wiki pages or require the optional LSP for these checks.

The command layer downloads and validates the dump before audits, stores it in
the app cache under `class-metadata/dump.json`, and checks for updates at most once
every six hours. Concurrent checks share one refresh. Failed downloads retain
the last usable schema and the existing bundled migration checks; failures are
logged. With no cached schema and no connection, only the bundled checks run.
No project content is sent to the metadata service.

Class/property comparisons use numeric IDs, including inherited properties and
objects nested in lists, maps and options. Container element types are checked
even when the container is empty. Unknown classes/properties and unknown type
tags are skipped. Metadata mismatches are warnings because the published dump
may differ from the user's game build; the diagnostic identifies its version.
This checks declared types, not every possible value or object-layout constraint.
Supported dump formats are 0–3; an unsupported future format keeps the old cache.

The existing migration checks retain their severity and own overlapping findings,
so one mismatch does not produce both a migration and a schema warning. Repeated
instances are counted within a finding. Default editor checks operate on the saved
BIN and refresh after saving, not on every unsaved keystroke. Named and hashed
declarations both support line lookup.

A finding reports every line that declares the flagged property on the flagged class,
located by tracking the enclosing class of each open block in the rendered text. An
identically named property on a class the check did not flag is therefore left out.
Findings carry a one-line message for list rows and tree tooltips, with the explanation
and the correction in a separate detail field.

## Applying a retype

A finding whose declaration can be corrected by swapping the type keyword carries the
class, field, both types and those lines. The bin editor lists findings as rows, opens
one in a modal, and applies the retype as a single editor edit across every reported
line, leaving the file modified for review. Lines are re-read before the edit and one
that no longer declares the same field with the same type is left alone and reported,
because findings describe the saved file and the buffer can have moved since.

A retype is offered only where the keyword is the whole correction:

- `string` to `file` keeps the quoted path, so it is offered.
- `hash` to `file` is not, in either the value or a map key: fnv1a is not xxh64 and the
  path a hash stood for cannot be recovered from it.
- A narrowing numeric retype, `u32` to `u8` for example, is offered only when every
  value in the finding fits the narrower type. One oversized value withdraws the fix
  for the whole finding, since the edit covers all of its lines at once.
- A retired embed layout is not, because the embed has to be rebuilt as another class.

Check Files applies the same retypes in bulk. A row carrying a fix gets its own button, and
the footer applies every one in the report behind a confirmation. Fixes are grouped by file so
a bin is rendered, rewritten and saved once however many findings it carries, and one restore
point is taken before the batch. Each line is re-verified against the type the finding saw
before it is written; a line that no longer matches is skipped and counted. Writing goes
through the same path as an editor save, which is what records a newly hashed path in
`files.txt` beside the mod.

Where no retype is offered, the detail says why. For a string-to-file mismatch it tells
the user to change `TexturePath: string =` to `TexturePath: file =` and keep the path.
The optional LSP's equivalent warning explains this correction as well; the LSP path has
no fix buttons of its own.

Validation: `cargo test -p flint-bin --lib --offline` exercises inheritance,
hashed IDs, nested objects, empty containers, valid strings, and migration overlap.
To verify an actual downloaded release dump, set `FLINT_META_DUMP` to its path and
run `cargo test -p flint-bin published_dump --offline -- --ignored`.
