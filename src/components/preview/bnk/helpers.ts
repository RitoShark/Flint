/**
 * Pure helpers used by BnkPreview - byte formatting, file-tree walking,
 * BIN/companion-bank discovery, event grouping, and WAV magic-byte check.
 * No React state.
 */
import type { FileTreeNode, EventMapping } from '../../../lib/types';
import type { EventGroup } from './types';

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Extract a `skinNN` token from a path, returning the numeric part (zero-padded preserved). */
export function extractSkinToken(path: string): string | null {
    const m = /skin(\d+)/i.exec(path);
    return m ? m[1] : null;
}

/** Walk a FileTreeNode and collect all file paths matching a predicate. */
export function walkTreeFiles(root: FileTreeNode | null, predicate: (path: string) => boolean): string[] {
    if (!root) return [];
    const out: string[] = [];
    const stack: FileTreeNode[] = [root];
    while (stack.length) {
        const node = stack.pop()!;
        if (!node.isDirectory && predicate(node.path)) {
            out.push(node.path);
        }
        if (node.children) stack.push(...node.children);
    }
    return out;
}

/**
 * Pick the most likely sibling skin BIN for a given BNK/WPK path.
 * Strategy: look for `.bin` files whose path contains the same `skinNN` token
 * as the bank file. Prefer paths that also contain `data/characters`. If multiple
 * remain, pick the shortest path (usually the canonical skin definition, not a
 * nested subvariant).
 */
export function findBinCandidate(bankPath: string, fileTree: FileTreeNode | null): string | null {
    const bankSkin = extractSkinToken(bankPath);
    if (!bankSkin) return null;

    const allBins = walkTreeFiles(fileTree, (p) => /\.bin$/i.test(p));
    const skinRe = new RegExp(`skin0*${bankSkin}(?:\\b|[^0-9])`, 'i');
    const matchedSkin = allBins.filter((p) => skinRe.test(p));
    if (matchedSkin.length === 0) return null;

    const preferred = matchedSkin.filter((p) => /data[\\/]+characters/i.test(p));
    const pool = preferred.length ? preferred : matchedSkin;
    pool.sort((a, b) => a.length - b.length);
    return pool[0];
}

/**
 * Find a companion events BNK for the given audio bank.
 * League convention: `<stem>_audio.{bnk,wpk}` ↔ `<stem>_events.bnk` in the same folder.
 * Fallback: if the direct swap doesn't exist in the tree, look for any `*_events.bnk`
 * sharing the same `skinNN` token in the same directory branch.
 */
export function findCompanionEventsBank(
    bankRelPath: string,
    fileTree: FileTreeNode | null,
): string | null {
    const norm = bankRelPath.replaceAll('\\', '/');
    const allBanks = walkTreeFiles(fileTree, (p) =>
        /_events\.bnk$/i.test(p.replaceAll('\\', '/')),
    );
    if (allBanks.length === 0) return null;

    // Direct swap: foo_audio.bnk → foo_events.bnk  (or .wpk → _events.bnk)
    const swapped = norm
        .replace(/_audio\.bnk$/i, '_events.bnk')
        .replace(/_audio\.wpk$/i, '_events.bnk');
    if (swapped !== norm) {
        const hit = allBanks.find((p) => p.replaceAll('\\', '/').toLowerCase() === swapped.toLowerCase());
        if (hit) return hit;
    }

    // Fallback: same folder + same skin token
    const dir = norm.slice(0, norm.lastIndexOf('/'));
    const skinTok = extractSkinToken(norm);
    const sameFolder = allBanks.filter((p) => p.replaceAll('\\', '/').startsWith(dir + '/'));
    if (sameFolder.length === 1) return sameFolder[0];
    if (skinTok) {
        const skinRe = new RegExp(`skin0*${skinTok}(?:\\b|[^0-9])`, 'i');
        const matches = sameFolder.filter((p) => skinRe.test(p));
        if (matches.length >= 1) {
            matches.sort((a, b) => a.length - b.length);
            return matches[0];
        }
    }
    return null;
}

/** Group event mappings by event name, preserving WEM-id order (deduped). */
export function groupMappings(mappings: EventMapping[]): { events: EventGroup[]; mappedIds: Set<number> } {
    const byName = new Map<string, number[]>();
    const mappedIds = new Set<number>();
    for (const m of mappings) {
        mappedIds.add(m.wem_id);
        const arr = byName.get(m.event_name);
        if (arr) {
            if (!arr.includes(m.wem_id)) arr.push(m.wem_id);
        } else {
            byName.set(m.event_name, [m.wem_id]);
        }
    }
    const events: EventGroup[] = Array.from(byName.entries())
        .map(([name, wemIds]) => ({ name, wemIds }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return { events, mappedIds };
}
