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
