/**
 * Shared types/constants for in-app HTML5 drag-and-drop of file-tree items
 * between projects. The file tree (drag source) writes a `TreeDragPayload` onto
 * the dataTransfer under `TREE_DND_MIME`; a project tab (drop target) reads it
 * and opens the copy/move transfer dialog.
 */

export const TREE_DND_MIME = 'application/x-flint-tree';

export interface TreeDragPayload {
    /** Absolute path of the project the dragged item belongs to. */
    projectPath: string;
    /** Project-relative path (forward slashes) of the dragged file/folder. */
    relPath: string;
    /** Display name (filename only). */
    name: string;
    isDirectory: boolean;
}

/** Read and parse a `TreeDragPayload` from a drop event, or null if absent/invalid. */
export function readTreeDragPayload(e: { dataTransfer: DataTransfer | null }): TreeDragPayload | null {
    const raw = e.dataTransfer?.getData(TREE_DND_MIME);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as TreeDragPayload;
        if (!parsed.projectPath || !parsed.relPath) return null;
        return parsed;
    } catch {
        return null;
    }
}
