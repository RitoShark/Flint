import type { FileTreeNode } from '../types';
export interface LayerGhost { path: string; source: string; layer: string; size: number }
export function withLayerGhosts(tree: FileTreeNode | null, ghosts: LayerGhost[]): FileTreeNode | null {
    if (!tree || !ghosts.length) return tree;
    const copy = (node: FileTreeNode): FileTreeNode => ({ ...node, children: node.children?.map(copy) });
    const root = copy(tree);
    for (const ghost of ghosts) {
        let parent = root;
        const parts = ghost.path.split('/');
        for (let i = 0; i < parts.length; i++) {
            parent.children ??= [];
            let child = parent.children.find(n => n.name.toLowerCase() === parts[i].toLowerCase());
            if (!child) {
                child = { name: parts[i], path: parts.slice(0, i + 1).join('/'), isDirectory: i < parts.length - 1, ghostSource: ghost.source, ghostLayer: ghost.layer };
                parent.children.push(child);
                parent.children.sort((a,b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
            }
            parent = child;
        }
    }
    return root;
}
