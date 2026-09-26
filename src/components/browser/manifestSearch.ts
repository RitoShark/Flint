import type { CdnTreeNode, CdnWadChunk } from '../../lib/api/cdn';

export function searchManifestTree(tree: CdnTreeNode, loaded: Map<number, CdnWadChunk[]>, query: string) {
    const needle = query.trim().replace(/\\/g, '/').toLowerCase();
    const paths = new Set<string>();
    const wadChunks = new Map<number, CdnWadChunk[]>();
    const walk = (node: CdnTreeNode, parentMatch: boolean): boolean => {
        const matches = parentMatch || !needle || node.path.toLowerCase().includes(needle);
        let visible = matches;
        for (const child of node.children) visible = walk(child, matches) || visible;
        if (node.file_index != null) {
            const chunks = loaded.get(node.file_index);
            if (chunks) {
                const filtered = matches ? chunks : chunks.filter(c =>
                    (c.path ?? '').toLowerCase().includes(needle) || c.hash.toLowerCase().includes(needle));
                wadChunks.set(node.file_index, filtered);
                visible ||= filtered.length > 0;
            }
        }
        if (visible) paths.add(node.path);
        return visible;
    };
    walk(tree, false);
    return { paths, wadChunks };
}
