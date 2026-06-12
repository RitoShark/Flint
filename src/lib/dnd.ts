/**
 * Shared payload type for cross-project drag of file-tree items. The file tree
 * carries this on a custom pointer-drag (see `pointerDrag.ts` — HTML5 DnD is
 * blocked by WebView2's native drag-drop), and the transfer store / modal
 * consume it to copy/move the items into another project. Supports dragging a
 * multi-selection at once.
 */

export interface TreeDragItem {
    /** Project-relative path (forward slashes). */
    relPath: string;
    /** Display name (filename only). */
    name: string;
    isDirectory: boolean;
}

export interface TreeDragPayload {
    /** Absolute path of the project the dragged items belong to. */
    projectPath: string;
    /** One or more items being dragged (the active selection). */
    items: TreeDragItem[];
}
