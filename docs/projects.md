# Working with projects

[Documentation index](README.md) · [Configuration reference](flint-json.md) · [CDN files](cdn.md)

A Flint project is a directory of editable game files plus metadata. Opening a file changes the working copy on disk when you save it. Export creates a mod package from the project content; it does not turn the project folder itself into a League installation.

## Project layout

```text
My Skin/
  mod.config.json
  flint.json
  files.txt
  thumbnail.webp
  content/
    base/
      Ahri.wad.client/
        data/characters/ahri/...
        assets/mycreator/my-skin/...
    optional-layer/
      Ahri.wad.client/...
  output/
  .flint/
    checkpoints/
    objects/
```

This is an illustrative layout. `files.txt`, artwork, additional layers and checkpoint storage appear when their workflows create them. The `.wad.client` entries **inside `content` are directories of loose files**, even though a downloaded `.wad.client` is an archive file.

| Part | What it does |
|---|---|
| `mod.config.json` | Shared mod metadata: `name` is a slug, `display_name` is the readable title, `version` is the mod's version, `description` and `authors` describe the mod, and `layers` declares content layers. Flint carries additional unmodeled keys through its save path. |
| `flint.json` | Flint identity, project kind, source provenance and extraction choices. See the [complete field reference](flint-json.md). |
| `content/base` | Default editable content layer. |
| `content/<layer>` | Additional registered layer's content. Layer names and priorities are declared in `mod.config.json`; merely creating a directory does not register it. |
| `<wad>.wad.client/` | Associates its contents with a game WAD. The inner path is the game's asset path. |
| `files.txt` | Preserves readable custom names that cannot be recovered from a one-way hash alone. Keep it with the project. |
| `output` | Default output directory exposed by the project model. Export dialogs can choose destinations. |
| `.flint` | Local checkpoint metadata and deduplicated file objects. Keep it when moving a project if you want its history. |

For example, `content/base/Ahri.wad.client/data/characters/ahri/skins/skin0.bin` associates the asset `data/characters/ahri/skins/skin0.bin` with `Ahri.wad.client`. Neither `content/base` nor `Ahri.wad.client` belongs in that asset's path hash. Keep the layer and WAD boundaries when adding files manually.

## Creating a skin project

1. Configure the League installation and projects destination in Flint. Choose the intended Live or PBE source.
2. Create a project, choose the champion and skin/chroma, and supply the project/creator names. Choose whether to include SFX and voiceover.
3. Flint creates the directory and metadata, finds the source WAD, and extracts assets into `content/base`.
4. For skin extraction, it first follows the selected skin BIN's references to collect needed files. If that selective extraction fails, it falls back to the broader WAD extraction path.
5. When a nonempty creator name enables organization, Flint merges linked BIN content, rewrites asset references into the creator/project namespace, relocates files and cleans up unused material. It records custom names and saves the final provenance.
6. Inspect the files and preview the result. Extraction success does not establish that every later organization or optional voiceover step succeeded; those steps can report warnings while leaving a usable project.

Repathing must update both sides of a reference: the name in the BIN and the file's location. Renaming folders in Explorer alone breaks that relationship. Flint's rename operation coordinates metadata, asset moves and reference changes.

TFT creation has a separate path: it merges linked BINs but skips the usual skin repath, using the companions WAD association. Map and loading-screen projects also have dedicated creation workflows; changing `kind` manually does not run them.

## Opening, moving and importing

Open the project directory or its `mod.config.json` / `flint.json`. The loader requires `mod.config.json` and combines it with Flint metadata. A stable `pid` lets the `projects.json` index recognize the project after a move or rename. The index lives at the projects-root level; it is not the project's content manifest.

Move the whole project folder to retain metadata, custom names and history. Reopen it at the new location to refresh the index. Sharing the project means sharing those editable source files; sharing an exported package means sharing an installation artifact.

The import workflows accept `.fantome`, `.modpkg`, and supported extracted-folder layouts. Package recovery can use your installed game to restore missing dependencies or shared BIN content. A folder of downloaded assets is not automatically a Flint project: it needs the project metadata and the correct layer/WAD layout. See [bringing CDN assets into a project](cdn.md#using-downloaded-files-in-a-project).

## Editing, checking and checkpoints

Preview files before changing them. BIN files contain typed references and configuration; meshes, textures, animations and audio provide the referenced resources. Flint renders BINs as editable ritobin text and encodes them back into binary when saved. Custom path names need to survive that process too; see [formats and references](formats-and-references.md).

Use **Check files** to find invalid types, missing references, texture problems and unused files. A stock game reference can intentionally remain outside the mod; a custom repathed reference needs a corresponding asset. Read the finding rather than assuming every missing local file has the same consequence.

Create a checkpoint before a broad change. Checkpoints store a manifest of project files and SHA-256-addressed content under `.flint`, so unchanged bytes can be reused across snapshots. The scan excludes directories named `.flint`, `.git`, `node_modules`, and `output`. Restoring a checkpoint changes the working files; exported packages in `output` are not part of that snapshot.

## Export and installation

Export supports `.fantome` and `.modpkg`; launcher integration can sync into Celestial or LTK Manager. These are distinct from saving an editor buffer or downloading a WAD. Check the export preflight and resolve relevant findings before packaging.

For `.modpkg`, the WAD association is stored separately from the WAD-relative asset path. Layers also remain part of the packaging model. Avoid flattening the project tree or prepending WAD names to asset paths: that changes the identity the game expects.

Implementation entry points: [project commands](../src-tauri/src/commands/project/project.rs), [project model](../src-tauri/crates/flint-core/src/project/project.rs), [layers](../src-tauri/src/commands/project/layers.rs), [checkpoint storage](../src-tauri/crates/flint-core/src/checkpoint.rs), and [import/export commands](../src-tauri/src/commands/import_export).
