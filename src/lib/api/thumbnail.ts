import { invokeCommand } from './core';

/**
 * Opens the standalone Thumbnail Creator window for the given .skn model.
 * Mirrors the map-preview multi-window pattern — see CLAUDE.md "Multi-window
 * pattern". If a thumbnail window is already open, the backend just focuses
 * it (it does not re-target to a different .skn — known v1 limitation).
 */
export async function openThumbnailWindow(project: string, skn: string): Promise<void> {
    return invokeCommand('open_thumbnail_window', { projectPath: project, sknPath: skn });
}

/**
 * Loads a bundled disc-composite asset ("ring" | "glow") as raw WebP bytes.
 * Backed by `load_thumbnail_asset` (raw-bytes IPC, `include_bytes!`'d into
 * the binary — see CLAUDE.md "Raw-bytes IPC").
 */
export async function loadThumbnailAsset(name: 'ring' | 'glow'): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('load_thumbnail_asset', { name });
    return new Uint8Array(buf);
}
