import type { FileIssueTag } from '../stores/appMetadataStore';

export type TreeTag = 'critical' | 'warning' | 'new' | 'modified';

const RANK: Record<TreeTag, number> = { critical: 4, warning: 3, new: 2, modified: 1 };

export const TAG_LETTER: Record<TreeTag, string> = {
    critical: 'E',
    warning: 'W',
    new: 'N',
    modified: 'M',
};

export function strongerTag(a: TreeTag | undefined, b: TreeTag | undefined): TreeTag | undefined {
    if (!a) return b;
    if (!b) return a;
    return RANK[a] >= RANK[b] ? a : b;
}

export interface TreeDecorations {
    /** rel path, original disk case → git-style status. */
    fileStatus: Map<string, 'new' | 'modified'>;
    /** rel path, lowercased → audit finding. */
    fileIssue: Map<string, FileIssueTag>;
    /** folder rel path, lowercased → strongest tag rolled up from its subtree. */
    folderTag: Map<string, TreeTag>;
}

function parentOf(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i === -1 ? '' : rel.slice(0, i);
}

function lastSegment(rel: string): string {
    const i = rel.lastIndexOf('/');
    return i === -1 ? rel : rel.slice(i + 1);
}

/**
 * GitHub-style roll-up: every ancestor folder carries the strongest tag of its
 * subtree, and the propagation stops at the `.wad.client` folder — the layers
 * above it (`content/base`) are rendered compacted into the WAD row anyway, and
 * a project-root that is always tinted tells the user nothing.
 */
export function rollUpFolderTags(fileTags: Iterable<[string, TreeTag]>): Map<string, TreeTag> {
    const folders = new Map<string, TreeTag>();
    for (const [relLower, tag] of fileTags) {
        let dir = parentOf(relLower);
        while (dir !== '') {
            const existing = folders.get(dir);
            // Every walk runs to the boundary, so an ancestor is always >= its
            // children — a dir already at >= tag means the rest are too.
            if (existing && RANK[existing] >= RANK[tag]) break;
            folders.set(dir, tag);
            if (lastSegment(dir).endsWith('.wad.client')) break;
            dir = parentOf(dir);
        }
    }
    return folders;
}

/**
 * Projects the absolute-keyed store maps onto project-relative keys and rolls
 * folder tags up from them, in one pass per map.
 */
export function buildTreeDecorations(
    projectPath: string,
    statusEntries: Iterable<[string, 'new' | 'modified']>,
    issueEntries: Iterable<[string, FileIssueTag]>,
): TreeDecorations {
    const fileStatus = new Map<string, 'new' | 'modified'>();
    const fileIssue = new Map<string, FileIssueTag>();
    const fileTags = new Map<string, TreeTag>();

    const norm = projectPath.replaceAll('\\', '/');
    const prefix = `${norm}/`;
    const prefixLower = prefix.toLowerCase();

    for (const [absKey, status] of statusEntries) {
        if (!absKey.startsWith(prefix)) continue;
        const rel = absKey.slice(prefix.length);
        fileStatus.set(rel, status);
        const relLower = rel.toLowerCase();
        fileTags.set(relLower, strongerTag(fileTags.get(relLower), status)!);
    }

    for (const [absKeyLower, issue] of issueEntries) {
        if (!absKeyLower.startsWith(prefixLower)) continue;
        const relLower = absKeyLower.slice(prefixLower.length);
        fileIssue.set(relLower, issue);
        fileTags.set(relLower, strongerTag(fileTags.get(relLower), issue.severity)!);
    }

    return { fileStatus, fileIssue, folderTag: rollUpFolderTags(fileTags) };
}
