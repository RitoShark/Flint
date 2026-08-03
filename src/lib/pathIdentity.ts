/**
 * Identity comparison for OS paths that reach the frontend spelled two different ways.
 *
 * The same file can arrive as a forward-slash path built here (`${projectPath}/${selectedFile}`)
 * or as an OS path handed back by Rust — `Path::join` uses `\` on Windows, and resolvers that
 * hop between sibling folders leave `..` segments in place. Comparing those with `===` reports
 * "different file", which is enough to make React remount a viewer that should have been reused.
 */

/** Collapse separators, `.`/`..` segments and case into one comparable form. */
export function normalizeOsPath(path: string): string {
    const out: string[] = [];
    for (const segment of path.replace(/\\/g, '/').split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            out.pop();
            continue;
        }
        out.push(segment);
    }
    // Windows paths are case-insensitive, and these only ever compare local files.
    return out.join('/').toLowerCase();
}

/** True when both paths name the same file, however they're spelled. */
export function isSamePath(a: string, b: string): boolean {
    return normalizeOsPath(a) === normalizeOsPath(b);
}
