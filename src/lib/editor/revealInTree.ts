import { useProjectTabStore } from '../stores';
import type { FileTreeNode } from '../types';

/**
 * Selects a file in the active project tree from a lowercased relative path, expanding
 * every ancestor. Audit reports lowercase their paths while tree nodes keep disk case,
 * so the walk matches case-insensitively and selects the real-cased node path.
 */
export function revealInTree(relPathLower: string): boolean {
    const state = useProjectTabStore.getState();
    const tab = state.openTabs.find((t) => t.id === state.activeTabId);
    if (!tab?.fileTree) return false;

    const segments = relPathLower.replaceAll('\\', '/').split('/').filter(Boolean);
    let node: FileTreeNode = tab.fileTree;
    const folders: string[] = [];
    for (const segment of segments) {
        const child = node.children?.find((c) => c.name.toLowerCase() === segment);
        if (!child) return false;
        if (child.isDirectory) folders.push(child.path);
        node = child;
    }

    if (folders.length > 0) state.bulkSetFolders(tab.id, folders, true);
    state.setSelectedFile(tab.id, node.path);
    return true;
}
