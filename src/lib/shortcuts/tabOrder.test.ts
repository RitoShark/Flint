import { describe, it, expect } from 'vitest';
import {
    buildTabList,
    activeTabIndex,
    stepTab,
    tabAtSlot,
    WAD_EXPLORER_TAB_ID,
    type TabSnapshot,
    type ActiveTabState,
} from './tabOrder';

const empty: TabSnapshot = {
    wadExplorerOpen: false,
    fileEditorTabIds: [],
    projectTabIds: [],
    extractSessionIds: [],
    manifestSessionIds: [],
    archiveTabIds: [],
};

const noneActive: ActiveTabState = {
    view: 'welcome',
    fileEditorActiveId: null,
    projectActiveId: null,
    extractActiveId: null,
    manifestActiveId: null,
    archiveActiveId: null,
};

describe('buildTabList', () => {
    it('is empty when nothing is open', () => {
        expect(buildTabList(empty)).toEqual([]);
    });

    it('orders families exactly as TitleBar renders them', () => {
        // TitleBar.tsx:570-663 — WAD Explorer, file editors, projects, extracts,
        // manifests, archives. Keyboard order must match the visible strip or
        // Ctrl+3 lands somewhere the user isn't looking.
        const list = buildTabList({
            wadExplorerOpen: true,
            fileEditorTabIds: ['fe1'],
            projectTabIds: ['p1', 'p2'],
            extractSessionIds: ['x1'],
            manifestSessionIds: ['m1'],
            archiveTabIds: ['a1'],
        });

        expect(list.map((t) => t.kind)).toEqual([
            'wad-explorer', 'file-editor', 'project', 'project', 'extract', 'manifest', 'archive',
        ]);
        expect(list.map((t) => t.id)).toEqual([
            WAD_EXPLORER_TAB_ID, 'fe1', 'p1', 'p2', 'x1', 'm1', 'a1',
        ]);
    });

    it('omits the WAD Explorer pseudo-tab when it is closed', () => {
        const list = buildTabList({ ...empty, projectTabIds: ['p1'] });
        expect(list.map((t) => t.kind)).toEqual(['project']);
    });

    it('includes archive- prefixed extract sessions, because TitleBar renders them', () => {
        // navigationCoordinator excludes these as *fallback* targets, but
        // TitleBar.tsx:637 maps extractSessions unfiltered, so they are visible tabs.
        const list = buildTabList({ ...empty, extractSessionIds: ['archive-1', 'x2'] });
        expect(list.map((t) => t.id)).toEqual(['archive-1', 'x2']);
    });
});

describe('activeTabIndex', () => {
    const list = buildTabList({
        wadExplorerOpen: true,
        fileEditorTabIds: ['fe1'],
        projectTabIds: ['p1', 'p2'],
        extractSessionIds: [],
        manifestSessionIds: [],
        archiveTabIds: [],
    });

    it('locates the active project tab', () => {
        expect(activeTabIndex(list, {
            ...noneActive, view: 'preview', projectActiveId: 'p2',
        })).toBe(3);
    });

    it('locates the WAD Explorer pseudo-tab', () => {
        expect(activeTabIndex(list, { ...noneActive, view: 'wad-explorer' })).toBe(0);
    });

    it('locates the active file-editor tab', () => {
        expect(activeTabIndex(list, {
            ...noneActive, view: 'file-editor', fileEditorActiveId: 'fe1',
        })).toBe(1);
    });

    it('returns -1 on the welcome screen', () => {
        expect(activeTabIndex(list, noneActive)).toBe(-1);
    });

    it('returns -1 when the view has no id to match', () => {
        expect(activeTabIndex(list, { ...noneActive, view: 'preview', projectActiveId: null })).toBe(-1);
    });
});

describe('stepTab', () => {
    const list = buildTabList({ ...empty, projectTabIds: ['p1', 'p2', 'p3'] });

    it('advances to the next tab', () => {
        expect(stepTab(list, 0, 1)?.id).toBe('p2');
    });

    it('wraps forward past the last tab', () => {
        expect(stepTab(list, 2, 1)?.id).toBe('p1');
    });

    it('wraps backward past the first tab', () => {
        expect(stepTab(list, 0, -1)?.id).toBe('p3');
    });

    it('starts at the first tab when nothing is active', () => {
        expect(stepTab(list, -1, 1)?.id).toBe('p1');
    });

    it('starts at the last tab when nothing is active and stepping back', () => {
        expect(stepTab(list, -1, -1)?.id).toBe('p3');
    });

    it('returns null for an empty list', () => {
        expect(stepTab([], -1, 1)).toBeNull();
    });
});

describe('tabAtSlot', () => {
    const list = buildTabList({ ...empty, projectTabIds: ['p1', 'p2', 'p3'] });

    it('maps slot 1 to the first tab', () => {
        expect(tabAtSlot(list, 1)?.id).toBe('p1');
    });

    it('maps slot 9 to the last tab regardless of count', () => {
        // Browser convention: Ctrl+9 is "last tab", not "ninth tab".
        expect(tabAtSlot(list, 9)?.id).toBe('p3');
    });

    it('returns null for a slot beyond the open tabs', () => {
        expect(tabAtSlot(list, 5)).toBeNull();
    });

    it('returns null for slot 1 on an empty list', () => {
        expect(tabAtSlot([], 1)).toBeNull();
    });

    it('maps slot 9 to the only tab when one is open', () => {
        expect(tabAtSlot(buildTabList({ ...empty, projectTabIds: ['solo'] }), 9)?.id).toBe('solo');
    });
});
