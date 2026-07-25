import { useProjectTabStore } from '../stores/projectTabStore';
import { useWadExtractStore } from '../stores/wadExtractStore';
import { useFileEditorStore } from '../stores/fileEditorStore';
import { useArchiveTabStore } from '../stores/archiveTabStore';
import { useCdnManifestStore } from '../stores/cdnManifestStore';
import { useWadExplorerStore } from '../stores/wadExplorerStore';
import { useNavigationStore } from '../stores/navigationStore';
import { navigationCoordinator } from '../stores/navigationCoordinator';
import {
    buildTabList,
    activeTabIndex,
    stepTab,
    tabAtSlot,
    type ActiveTabState,
    type TabRef,
    type TabSnapshot,
} from './tabOrder';

/**
 * Impure side of tab navigation: read the six tab stores, and activate a tab.
 *
 * Activation mirrors TitleBar's own click handlers (TitleBar.tsx:462-508) exactly,
 * so keyboard and mouse cannot diverge — each family needs both a store switch and
 * a view change, and doing only one leaves the strip highlighting a tab that isn't
 * showing.
 */

function readSnapshot(): TabSnapshot {
    return {
        wadExplorerOpen: useWadExplorerStore.getState().isOpen,
        fileEditorTabIds: useFileEditorStore.getState().tabs.map((t) => t.id),
        projectTabIds: useProjectTabStore.getState().openTabs.map((t) => t.id),
        extractSessionIds: useWadExtractStore.getState().extractSessions.map((s) => s.id),
        manifestSessionIds: Object.values(useCdnManifestStore.getState().sessions)
            .map((s) => s.sessionId),
        archiveTabIds: useArchiveTabStore.getState().openArchiveTabs.map((t) => t.id),
    };
}

function readActive(): ActiveTabState {
    const nav = useNavigationStore.getState();
    return {
        view: nav.currentView,
        fileEditorActiveId: useFileEditorStore.getState().activeId,
        projectActiveId: useProjectTabStore.getState().activeTabId,
        extractActiveId: useWadExtractStore.getState().activeExtractId,
        manifestActiveId: nav.activeManifestId,
        archiveActiveId: useArchiveTabStore.getState().activeArchiveTabId,
    };
}

export function activateTab(ref: TabRef): void {
    const nav = useNavigationStore.getState();

    switch (ref.kind) {
        case 'wad-explorer':
            navigationCoordinator.openWadExplorer();
            return;
        case 'file-editor':
            useFileEditorStore.getState().switchTab(ref.id);
            nav.setView('file-editor');
            return;
        case 'project':
            useProjectTabStore.getState().switchTab(ref.id);
            nav.setView('preview');
            return;
        case 'extract':
            useWadExtractStore.getState().switchSession(ref.id);
            nav.setView('extract');
            return;
        case 'manifest':
            nav.setActiveManifest(ref.id);
            nav.setView('manifest');
            return;
        case 'archive':
            useArchiveTabStore.getState().switchArchiveTab(ref.id);
            nav.setView('archive-editor');
            return;
    }
}

/** Move `delta` tabs through the visible strip, wrapping at both ends. */
export function cycleTab(delta: number): void {
    const list = buildTabList(readSnapshot());
    const next = stepTab(list, activeTabIndex(list, readActive()), delta);
    if (next) activateTab(next);
}

/** Activate a numbered slot; 9 means "last tab". No-op if the slot is empty. */
export function jumpToTabSlot(slot: number): void {
    const list = buildTabList(readSnapshot());
    const target = tabAtSlot(list, slot);
    if (target) activateTab(target);
}
