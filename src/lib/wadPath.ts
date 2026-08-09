/**
 * Project-relative paths carry a `content/<layer>/<name>.wad.client/` prefix that only
 * means something to Flint's on-disk layout. What a modder actually pastes — into a BIN
 * field, a chat message, another tool — is the path as the GAME sees it, which starts at
 * `assets/` or `data/`.
 *
 * Mirrors `split_project_path` in `src-tauri/src/commands/project/compare.rs`, which is
 * private to that module and not exposed as a command.
 */

/**
 * The in-WAD portion of a project-relative path, or null when the path isn't inside a
 * `.wad.client` folder (project metadata like `flint.json`, or the WAD folder itself).
 *
 * Handles both layouts: the current `content/<layer>/<wad>.wad.client/<rest>` and the
 * legacy `content/<wad>.wad.client/<rest>`, by locating the `.wad.client` segment rather
 * than counting from the front.
 */
export function wadInternalPath(projectRelPath: string): string | null {
    const normalized = projectRelPath.replace(/\\/g, '/');
    if (!normalized.toLowerCase().startsWith('content/')) return null;

    const segments = normalized.slice('content/'.length).split('/');
    const wadIdx = segments.findIndex((s) => s.toLowerCase().endsWith('.wad.client'));
    if (wadIdx === -1 || wadIdx + 1 >= segments.length) return null;

    const internal = segments.slice(wadIdx + 1).join('/');
    return internal.length > 0 ? internal : null;
}

/**
 * What "copy path" should put on the clipboard: the in-WAD path when there is one, else
 * the project-relative path unchanged. Never returns an empty string, so a copy action
 * always yields something pasteable.
 */
export function copyablePath(projectRelPath: string): string {
    return wadInternalPath(projectRelPath) ?? projectRelPath.replace(/\\/g, '/');
}

/**
 * The project root an ABSOLUTE file path sits under, found by locating the
 * `content/` segment a Flint project always has.
 *
 * The standalone file editor opens a BIN with no project tab behind it, so
 * anything project-scoped there (workspace search) has to re-derive the root
 * from the file itself. Returns null for a file outside any project.
 */
export function projectRootFromFilePath(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    const contentIdx = segments.findIndex((s) => s.toLowerCase() === 'content');
    if (contentIdx <= 0) return null;
    return segments.slice(0, contentIdx).join('/');
}
