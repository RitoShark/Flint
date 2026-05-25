/**
 * Sidecar / derived file detection.
 *
 * Sidecar files are produced BY Flint during the course of editing source
 * assets — they are not user-authored. The user shouldn't see VFS status
 * indicators ("modified" / "new" badges) for them, even though the file
 * watcher correctly reports modifications.
 *
 * Examples:
 *   - `Skin0.bin` saved by the editor produces a `Skin0.bin.ritobin` sidecar
 *     (or vice versa, depending on which was edited).
 *   - Recolor / cache outputs may produce `*.tex.png` style derivative caches.
 *
 * NOTE: this only suppresses the status badge. Hot-reload (fileVersions) and
 * tree refresh (fileTreeVersion) still need to fire, otherwise previews go
 * stale.
 */
const SIDECAR_SUFFIXES = ['.ritobin'] as const;

export function isSidecarFile(path: string): boolean {
    const lower = path.toLowerCase();
    return SIDECAR_SUFFIXES.some((suf) => lower.endsWith(suf));
}
