import type { ViewType } from '../types';

/**
 * Cross-family tab ordering.
 *
 * TitleBar renders six independent tab families into one visual strip. Nothing in
 * the app previously modelled that strip as an ordered list, so there was no way
 * to say "the next tab" or "the third tab". This module is that model, kept pure
 * so the ordering rules are testable without mounting the title bar.
 *
 * The ordering MUST mirror TitleBar.tsx:570-663. If a tab is visible, a slot
 * shortcut has to be able to reach it, and in the position the user sees.
 */

export type TabKind =
    | 'wad-explorer'
    | 'file-editor'
    | 'project'
    | 'extract'
    | 'manifest'
    | 'archive';

export interface TabRef {
    kind: TabKind;
    id: string;
}

/** The WAD Explorer is a singleton pseudo-tab with no store id of its own. */
export const WAD_EXPLORER_TAB_ID = '__wad_explorer__';

export interface TabSnapshot {
    wadExplorerOpen: boolean;
    fileEditorTabIds: string[];
    projectTabIds: string[];
    /** Unfiltered, including 'archive-' sessions — TitleBar renders those too. */
    extractSessionIds: string[];
    manifestSessionIds: string[];
    archiveTabIds: string[];
}

export interface ActiveTabState {
    view: ViewType;
    fileEditorActiveId: string | null;
    projectActiveId: string | null;
    extractActiveId: string | null;
    manifestActiveId: string | null;
    archiveActiveId: string | null;
}

/** Flatten the six families into the visible left-to-right order. */
export function buildTabList(s: TabSnapshot): TabRef[] {
    const list: TabRef[] = [];

    if (s.wadExplorerOpen) list.push({ kind: 'wad-explorer', id: WAD_EXPLORER_TAB_ID });
    for (const id of s.fileEditorTabIds) list.push({ kind: 'file-editor', id });
    for (const id of s.projectTabIds) list.push({ kind: 'project', id });
    for (const id of s.extractSessionIds) list.push({ kind: 'extract', id });
    for (const id of s.manifestSessionIds) list.push({ kind: 'manifest', id });
    for (const id of s.archiveTabIds) list.push({ kind: 'archive', id });

    return list;
}

/** Which view corresponds to which tab kind, and which id identifies the active one. */
function activeRef(active: ActiveTabState): TabRef | null {
    switch (active.view) {
        case 'wad-explorer':
            return { kind: 'wad-explorer', id: WAD_EXPLORER_TAB_ID };
        case 'file-editor':
            return active.fileEditorActiveId
                ? { kind: 'file-editor', id: active.fileEditorActiveId } : null;
        case 'preview':
            return active.projectActiveId
                ? { kind: 'project', id: active.projectActiveId } : null;
        case 'extract':
            return active.extractActiveId
                ? { kind: 'extract', id: active.extractActiveId } : null;
        case 'manifest':
            return active.manifestActiveId
                ? { kind: 'manifest', id: active.manifestActiveId } : null;
        case 'archive-editor':
            return active.archiveActiveId
                ? { kind: 'archive', id: active.archiveActiveId } : null;
        // 'welcome' and the legacy 'editor' | 'project' | 'checkpoints' views have
        // no tab of their own.
        default:
            return null;
    }
}

/** Index of the active tab in the list, or -1 when no tab is active. */
export function activeTabIndex(list: TabRef[], active: ActiveTabState): number {
    const ref = activeRef(active);
    if (!ref) return -1;
    return list.findIndex((t) => t.kind === ref.kind && t.id === ref.id);
}

/**
 * Move `delta` places through the list, wrapping at both ends.
 *
 * `currentIndex` of -1 (nothing active) enters the list from whichever end the
 * caller is heading toward, so Ctrl+Tab from the welcome screen lands on the
 * first tab rather than doing nothing.
 */
export function stepTab(list: TabRef[], currentIndex: number, delta: number): TabRef | null {
    if (list.length === 0) return null;
    if (currentIndex < 0) return delta >= 0 ? list[0] : list[list.length - 1];

    const next = (currentIndex + delta % list.length + list.length) % list.length;
    return list[next];
}

/**
 * Resolve a numeric slot to a tab.
 *
 * Slots 1-8 are positional; slot 9 means "last tab" regardless of how many are
 * open, matching browser and editor convention.
 */
export function tabAtSlot(list: TabRef[], slot: number): TabRef | null {
    if (list.length === 0) return null;
    if (slot === 9) return list[list.length - 1];
    if (slot < 1 || slot > list.length) return null;
    return list[slot - 1];
}
