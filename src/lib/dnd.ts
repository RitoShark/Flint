/**
 * Shared payload type for cross-project drag of file-tree items. The file tree
 * carries this on a custom pointer-drag (see `pointerDrag.ts` — HTML5 DnD is
 * blocked by WebView2's native drag-drop), and the transfer store / modal
 * consume it to copy/move the item into another project.
 */
export interface TreeDragPayload {
    /** Absolute path of the project the dragged item belongs to. */
    projectPath: string;
    /** Project-relative path (forward slashes) of the dragged file/folder. */
    relPath: string;
    /** Display name (filename only). */
    name: string;
    isDirectory: boolean;
}
