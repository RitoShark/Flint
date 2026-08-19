/**
 * Matching picked texture files to a model's submeshes.
 *
 * The folder override points at a directory and has to decide, per submesh,
 * which file re-skins it. League names rarely line up exactly: the Babylon mesh
 * is `mesh_Body` while the file on disk is `Kayn_Base_Body.dds`, so a plain
 * equality test matches almost nothing. We compare normalised stems and accept a
 * suffix hit, longest-suffix first, so `..._Body` beats a stray `body_glow`.
 *
 * Kept free of Tauri/Babylon imports so it unit-tests in the node environment
 * vitest runs in — the same convention `animFolder.ts` follows.
 */

export interface TextureFile {
    /** File name including the extension. */
    fileName: string;
    /** Absolute path, handed to the texture decoder. */
    path: string;
}

const TEXTURE_EXT = /\.(dds|tex|png|jpg|jpeg|webp)$/i;

export function isTextureFile(fileName: string): boolean {
    return TEXTURE_EXT.test(fileName);
}

/** Lowercased, extension-free, with the Babylon `mesh_` prefix dropped. */
export function normalizeName(name: string): string {
    return name.replace(TEXTURE_EXT, '').replace(/^mesh_/i, '').toLowerCase();
}

/**
 * Pick one file per submesh. Exact stem equality wins; otherwise the file whose
 * stem ends with the submesh name (or vice versa) and shares the longest run
 * with it. Submeshes with no candidate are simply absent from the result, so a
 * folder that only covers part of the model leaves the rest untouched.
 */
export function matchTexturesToMeshes(
    meshNames: string[],
    files: TextureFile[],
): Record<string, string> {
    const candidates = files
        .filter(f => isTextureFile(f.fileName))
        .map(f => ({ stem: normalizeName(f.fileName), path: f.path }));
    if (candidates.length === 0) return {};

    const out: Record<string, string> = {};
    for (const meshName of meshNames) {
        const mesh = normalizeName(meshName);
        if (!mesh) continue;

        const exact = candidates.find(c => c.stem === mesh);
        if (exact) {
            out[meshName] = exact.path;
            continue;
        }

        let best: { path: string; score: number } | null = null;
        for (const c of candidates) {
            const related = c.stem.endsWith(mesh) || mesh.endsWith(c.stem);
            if (!related) continue;
            const score = Math.min(c.stem.length, mesh.length);
            if (!best || score > best.score) best = { path: c.path, score };
        }
        if (best) out[meshName] = best.path;
    }
    return out;
}
