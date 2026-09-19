# Getting files from the CDN

[Documentation index](README.md) · [Project workflow](projects.md) · [Architecture](architecture.md)

Flint can browse and download game files from Riot's CDN without a local League installation. Use this workflow when you want individual assets or a WAD from a particular patch. It does not require a Flint project and does not automatically create one.

## Load a patch

1. Open **Load from CDN**.
2. Choose **Platform** (`Windows` or `macOS`), **Kind** (`Game`, `Client`, or `All`), and **Region**. Use `Game` for game asset WADs; `Client` is the standalone client content. `PBE1` selects the PBE catalog.
3. Filter by version/patch, select a build, and click **Load**. Use the refresh button to check the catalog for newly listed manifests.
4. Expand the manifest's folders, then expand a WAD to see its inner assets. Select an inner file to preview it.

The **Downloaded** badge means the manifest is cached on disk. It does not mean that its WADs or all patch files have been downloaded. A manifest is the recipe for finding and reconstructing files.

The language toggle hides non-default language WADs while keeping shared and `en_US` content. Switch to showing all languages when looking for another locale's voiceover.

## Download only a few assets

1. Expand the WAD that contains the assets you need.
2. Check the **inner file** rows. Leave the WAD's own checkbox unchecked if you do not also want the archive.
3. Click **Extract selected** and choose an output folder.
4. Inspect the result and the success/error report. By default, inner assets keep their resolved paths, such as `assets/...` or `data/...`.

The **Flat** extraction option saves selected inner files by filename rather than their directory tree. It adds numeric suffixes for duplicate filenames within the batch. Keep the directory tree when the result will be used in a mod, because BIN references depend on paths. The batch's name tracking is not a general protection against overwriting pre-existing destination files.

Selecting an inner asset fetches the compressed manifest chunks covering that asset's WAD byte range, then decodes the WAD entry. It can transfer more bytes than the final asset size because compression chunks are the fetch unit; it does not intentionally download the whole patch. Reading the WAD listing also requires its header/table chunks.

## Choose the correct extraction action

| Action | Result |
|---|---|
| Check inner files, then **Extract selected** | Decoded individual assets. Their resolved inner paths are retained unless flat extraction is enabled. |
| WAD row's **Extract** button, or right-click **Extract WAD (unpack files)** | All inner assets unpacked under `<chosen folder>/<wad name>/...`. |
| Right-click **Download WAD (raw file)** | The complete `.wad.client` archive at the save path you choose. |
| Check a WAD's own checkbox, then **Extract selected** | The WAD as a manifest file, preserving its manifest-relative location under the output folder. It is not automatically unpacked. |
| Extract a manifest folder | Its descendant manifest files, retaining manifest-relative paths. WAD files remain archives. |

Manifest-file selection and inner-file selection can be combined. Doing so can download both an archive and selected assets from it. Whole-WAD unpacking decodes every entry; it is not the economical choice when you only need one texture.

Names come from Flint's shared hash database. An unresolved hash can still identify and retrieve a WAD entry, but it cannot provide its original readable path. A hexadecimal filename means name resolution failed, not necessarily that downloading failed. Whole-WAD unpacking uses the hexadecimal hash for unnamed entries; it also falls back to a hash-based filename when a resolved destination path exceeds its length limit.

## Using downloaded files in a project

Download to a separate extraction directory first, then place the needed files in the intended project's `content/<layer>/<wad>.wad.client/` directory. For a file with inner path `data/characters/ahri/...`, retain that entire inner path beneath the WAD directory. Do not add the manifest's outer installation path to the asset's inner path.

An unpacked WAD directory can supply files for that layout. A raw `.wad.client` archive must first be browsed/extracted; dropping the archive where loose project assets belong does not unpack it.

A single BIN or mesh may refer to other assets. CDN selection downloads the items selected; it does not run the skin-project dependency extraction and repath pipeline. Gather required textures, skeletons, animations and linked BINs as appropriate, then check the project. Stock CDN paths also differ from a project's custom repathed namespace, so replacing a file may require updating references or using the matching custom destination.

The New Project skin workflow still reads a local League installation. CDN browsing is a separate source of files, not a `flint.json` option that redirects project creation to a remote patch. Loading a CDN build also does not change an existing project's recorded `source.game_version`.

## How the download works

1. **Catalog discovery:** the current version picker reads the `Morilli/riot-manifests` repository's tree, filters it by region/platform, and resolves a chosen catalog text entry to a Riot manifest URL. The backend also exposes Riot Sieve discovery through `cdn_list_manifests`; that is separate from the catalog picker.
2. **RMAN parsing:** Flint downloads or reuses the manifest and parses it with the RitoShark RMAN reader. This yields file paths and the bundle/chunk ranges needed for each file. A backend session holds the parsed manifest for the open browser tab.
3. **WAD browsing:** Flint fetches the leading manifest chunks until it can parse the WAD table of contents, with an eight-chunk limit. Hash lookup supplies readable names.
4. **Inner reads:** Flint requests the bundle ranges covering the chosen WAD entry, decompresses the manifest chunks, and decodes the entry's WAD compression. Subchunk compression can require additional metadata.
5. **Whole-file downloads:** the downloader fetches each compressed manifest chunk in its own HTTP range request, decompresses it and streams it into the destination. It checks compressed/decompressed sizes and validates chunk hashes when the manifest supplies a supported hash type. Large grouped requests are avoided because truncated responses have been observed.

The bundle URL is constructed as `https://lol.dyn.riotcdn.net/channels/public/bundles/<16-digit-uppercase-hex-id>.bundle`. This describes the endpoint used by the code, not a promise that every historical bundle remains available.

## Cache and troubleshooting

| Symptom / location | Meaning or next step |
|---|---|
| `%APPDATA%/Flint/cache/cdn` | Persistent catalog tree and resolved manifest URLs. Explicit refresh updates the catalog tree. |
| `%APPDATA%/Flint/manifest` | Downloaded manifest files, keyed by URL basename. This is not a complete game cache. |
| Cached manifest opens but assets will not download | Asset reads still need CDN access. Cached metadata does not make its contents available offline. |
| No matching version | Check platform, kind, region and filter text; refresh the catalog. The picker lists cataloged versions, not a guarantee of all builds ever shipped. |
| Missing locale WAD | Show all languages and check the chosen region/build. |
| Hexadecimal inner names | Check the shared hash database. The remote archive stores path hashes, not a complete readable filename table. |
| HTTP error, short body, decompression or validation failure | Inspect the reported file/error, retry into a clean destination, and verify the requested build remains accessible. Do not treat a partially written output as a successful download. |
| WAD table cannot be parsed within eight chunks | The current remote-listing limit was reached or the data is unsupported/invalid. Try downloading the raw WAD and browsing it locally. |
| Session not found | Reload the manifest to create a new backend session. |

Implementation: [picker](../src/components/modals/LoadManifestModal.tsx), [browser and extraction actions](../src/components/browser/ManifestBrowser.tsx), [Tauri commands](../src-tauri/src/commands/cdn/cdn.rs), [catalog](../src-tauri/crates/flint-net/src/cdn/catalog.rs), [downloader](../src-tauri/crates/flint-net/src/cdn/downloader.rs), [remote WAD reader](../src-tauri/crates/flint-net/src/cdn/wad_browse.rs).
