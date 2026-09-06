# Optional ritobin language server

Enable **Settings → Bin Editor → Use ritobin language server**. This is off by
default, including for existing installations. Enabling it also enables Auto
suggestions; that separate setting can still be turned off (Ctrl+Space continues
to request completions).

**LSP hover help** is a separate preference, off by default. It can be toggled
without restarting the server or editor. Even when enabled, LSP hovers are
suppressed inside quoted strings so Flint's file previews stay unobstructed.

While a BIN editor has LSP enabled, open the bottom log panel and select **LSP**.
This view shows the current file's connection state, pending requests, request
errors and diagnostics. Click a diagnostic to jump to its location. Diagnostics
clear immediately on edits and are replaced by the next matching server result;
the editor shows “checking” while waiting and never displays “Brackets OK” in LSP
mode. Server log notifications and stderr appear as one latest message, replaced
on new output and removed after eight seconds. There is no LSP history or persisted
log in this view. Closing the editor, switching files or disabling LSP discards
the snapshot. **Copy current** copies only the currently displayed snapshot.

Parser debug messages such as `UnexpectedItem`, `QuotedPropertyName` and
`MissingType` are displayed in plain language; expand **Original server message**
for the raw details. A missing bracket at EOF can cause many later type errors.
When the LSP reports exactly one missing closing bracket, Flint uses its existing
indentation recovery helper to suggest one local insertion, if unambiguous. This
helper supplies no diagnostics or bracket status in LSP mode. Suggestions appear
in the live panel and as editor Quick Fix actions near the affected block or EOF.
They are never applied automatically, carry the document version, support Undo,
and disappear immediately after editing. Applying a suggestion triggers a fresh
LSP check; other diagnostics are retained until that check or an edit clears them.
The editor highlights only the proposed insertion line, with an inline
“insert '}' after this line” hint that stays visible with hover help disabled.
Click **Bracket suggestion · line …** in the toolbar to jump to the insertion
point and open its Quick Fix menu. These decorations clear with stale diagnostics.

The editor uses ritobin-lsp for class/property/value completion, completion
details, hover documentation, formatting (Monaco's Format Document action), and
diagnostics. Flint's bracket checker, closing-bracket suggestions, inline audit
findings and automatic per-file audit refresh on save are disabled in this mode.
Turning the setting off restores them without replacing the editor or losing
unsaved edits/undo history. Project-wide audits remain independently available.
BIN serialization still validates the text when saving.

Flint continues to open, save, and unhash BINs through its existing implementation.
Its manual Unhash action and Auto unhash preference are unchanged. The LSP receives
the resulting editor text; it cannot invoke Flint's unhashing or perform BIN I/O.

## Hash isolation

Upstream **ritobin-lsp v0.1.18** starts Mimir updates unconditionally and does not
read its `hashPath` option. Setting an empty directory would not disable its hash
downloads. `scripts/lsp/patch-upstream.mjs` therefore builds a small Flint variant:

- No hash-store discovery, loading, or update implementation remains.
- Every server is initialized with `hashes: None`.
- The server advertises `capabilities.experimental.flintNoHashes = 1`.
- Flint refuses initialization without that marker, before sending `initialized`.
- The Rust IPC bridge allows only the implemented editor protocol methods.
  Unhash, BIN conversion, execute-command and code-action requests are excluded.
- Completion commands and server-initiated workspace edits are never applied.

The adapter also includes document versions in diagnostic notifications, allowing
Flint to discard results from older edits.

Flint resolves hashed class/property suggestions through its existing local
LMDB-backed BIN hash cache, including custom and extracted name overlays. One
batched lookup supplies only the suggested identifiers, without copying whole
databases into each LSP process. Labels, filtering, insertion and property-doc
requests use those names. Unknown hashes remain hexadecimal. Literal values and
document contents are never rewritten by this bridge, and no hash download is
triggered. It uses the same cache as Flint's existing unhash implementation.

Class schema metadata and hover documentation can still be fetched by the LSP.
The schema contains numeric class/property IDs; readable completion names come
from Flint's local hashes, not Mimir. No external hash cache is read or populated.
Text the user has already unhashed in Flint remains visible to the LSP.

## Distribution with Flint releases

The managed executable currently targets **Windows x64**, matching Flint's release
workflow. Users do not need Rust, a VS Code extension, or a manually installed LSP.

`.github/workflows/release.yml` resolves and validates the LSP only when Flint's
normal release trigger runs (a `v*` tag push). It selects the latest upstream
server release, checks out that exact tag, applies the adapter, builds with the
upstream lockfile, and runs a real protocol smoke test. Every Flint release runs
these checks, even if the upstream LSP version has not changed. A failed patch,
build, or smoke test stops the workflow before Flint is released.

The executable and `ritobin-lsp-manifest.json` (including SHA-256 and the Flint
version) are attached to that same normal Flint release in **RitoShark/Flint**.
There is no scheduled LSP workflow or separate LSP prerelease. The workflow uses
the repository's normal Actions `contents: write` permission and no new secret.

On first opted-in use, Flint installs the LSP from its own `v<app-version>` release.
A verified cached installation for that Flint version is reused without any
network update check. Installing a new Flint release selects that release's LSP
on next use; independent upstream LSP releases do not change an installed Flint.
Binaries live in Tauri's local app-data directory under `ritobin-lsp`. If a release
download fails, a previously cached executable is used only after checksum
verification. With the option off, Flint makes no LSP installation requests and
starts no LSP process. Closing the editor, disabling the setting, or exiting Flint
stops its session. Class metadata fetching is unchanged.

**First deployment:** publish a normal Flint release using the updated workflow.
An app version whose release has no LSP assets cannot perform a first-time LSP
installation; it displays an installation error. No upstream executable is used
as a fallback.

The adapter fails closed if its expected source boundaries change or known hash
I/O entry points remain. Such an upstream change requires adapting the build
script; existing installations keep their last working server. Ordinary upstream
releases are picked up automatically by the next Flint release workflow, with no
manual LSP version bump.

## Validation and attribution

For local development before publishing, stage an already built, patched server:

```powershell
node scripts/lsp/stage-dev.mjs ../.ritobin-lsp-reference/target/debug/ritobin-lsp.exe
```

Use the path to your patched upstream build; the upstream `dump.json` fixture must
remain beside its `target` directory. The command runs the real-server smoke test
and stages the executable plus checksum manifest in the already ignored
`src-tauri/binaries/ritobin-lsp` directory. Debug builds prefer that verified local
server when LSP is enabled, without contacting GitHub. Restart the Rust backend
after adding this support; refreshing the frontend does not replace a running
backend. Release builds exclude this local lookup and still install only from
their normal Flint release. This command performs no update checks or publishing.

Frontend tests cover hash-isolation refusal, document-scoped completion, command
stripping, edit ordering, stale diagnostics/formatting, local completion names,
quoted-path hover suppression, live hover preferences and disposal. Rust tests
cover message framing, method restrictions and installer manifest validation.
The build's smoke test exercises initialize, diagnostics, completion, close and
shutdown against the actual patched server, with metadata fetching disabled.
The current upstream release requires Rust 1.95 or newer when building it locally;
this does not change the compiler required to build Flint itself.

Upstream: [alanpq/ritobin-lsp](https://github.com/alanpq/ritobin-lsp), by alanpq,
declared `MIT OR Apache-2.0` in its workspace manifest. The LSP manifest identifies
the upstream source revision and this repository's adapter. Flint's distribution is a
patched upstream executable, not the VS Code extension.
