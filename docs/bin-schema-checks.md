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
BIN and refresh after saving, not on every unsaved keystroke. The expandable issue
list shows every finding, its expected declaration, and a navigation button where
a line can be located. It labels results as belonging to the saved file while edits
are pending. Named and hashed declarations both support line lookup.

For a string-to-file reference mismatch, the message tells the user to change
`TexturePath: string =` to `TexturePath: file =` and retain the path. The optional
LSP's equivalent warning now explains this correction as well.

Validation: `cargo test -p flint-bin --lib --offline` exercises inheritance,
hashed IDs, nested objects, empty containers, valid strings, and migration overlap.
To verify an actual downloaded release dump, set `FLINT_META_DUMP` to its path and
run `cargo test -p flint-bin published_dump --offline -- --ignored`.
