import { useProjectTabStore } from './projectTabStore';
import { useWadExtractStore } from './wadExtractStore';
import { useWadExplorerStore } from './wadExplorerStore';
import { useNavigationStore } from './navigationStore';
import { useFileEditorStore } from './fileEditorStore';
import { useArchiveTabStore } from './archiveTabStore';

export function removeTabWithFallback(tabId: string) {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  const { newActiveId, remainingTabs } = projectTab.removeTab(tabId);

  // "archive-" sessions are ArchiveEditor-internal (see closeArchiveTabWithFallback)
  // — never a user-facing fallback target.
  const userExtractSessions = wadExtract.extractSessions.filter(s => !s.embedded);
  const fileEditor = useFileEditorStore.getState();

  if (projectTab.activeTabId === tabId || remainingTabs.length === 0) {
    if (remainingTabs.length > 0 && newActiveId) {
      navigation.setView('preview');
    } else if (userExtractSessions.length > 0) {
      const activeIsUser = wadExtract.activeExtractId
        && userExtractSessions.some(s => s.id === wadExtract.activeExtractId);
      const sessionId = activeIsUser ? wadExtract.activeExtractId! : userExtractSessions[0].id;
      wadExtract.switchSession(sessionId);
      navigation.setView('extract');
    } else if (fileEditor.tabs.length > 0) {
      // Don't strand open standalone file tabs on the welcome screen.
      fileEditor.switchTab(fileEditor.activeId ?? fileEditor.tabs[0].id);
      navigation.setView('file-editor');
    } else if (wadExplorer.isOpen) {
      navigation.setView('wad-explorer');
    } else {
      navigation.setView('welcome');
    }
  }
}

function performCloseExtractSession(sessionId: string) {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  const { newActiveId, remainingSessions } = wadExtract.closeSession(sessionId);

  // Don't count ArchiveEditor-internal ("archive-") sessions as remaining tabs.
  const userRemaining = remainingSessions.filter(s => !s.embedded);

  if (wadExtract.activeExtractId === sessionId || remainingSessions.length === 0) {
    if (userRemaining.length > 0 && newActiveId && userRemaining.some(s => s.id === newActiveId)) {
      navigation.setView('extract');
    } else if (userRemaining.length > 0) {
      wadExtract.switchSession(userRemaining[0].id);
      navigation.setView('extract');
    } else if (projectTab.activeTabId && projectTab.openTabs.find(t => t.id === projectTab.activeTabId)) {
      navigation.setView('preview');
    } else if (projectTab.openTabs.length > 0) {
      projectTab.switchTab(projectTab.openTabs[0].id);
      navigation.setView('preview');
    } else if (wadExplorer.isOpen) {
      navigation.setView('wad-explorer');
    } else {
      navigation.setView('welcome');
    }
  }
}

export function closeExtractSessionWithFallback(sessionId: string) {
  const wadExtract = useWadExtractStore.getState();
  const session = wadExtract.extractSessions.find(s => s.id === sessionId);

  if (session?.isDirty) {
    import('./modalStore').then(({ useModalStore }) => {
      useModalStore.getState().openConfirmDialog({
        title: 'Unsaved WAD Changes',
        message: 'You have unsaved in-memory changes to this WAD file. Closing the tab will discard all changes. Are you sure you want to close it?',
        confirmLabel: 'Discard & Close',
        cancelLabel: 'Keep Open',
        danger: true,
        onConfirm: () => {
          performCloseExtractSession(sessionId);
        }
      });
    }).catch(err => {
      console.error('Failed to show close confirmation:', err);
      performCloseExtractSession(sessionId);
    });
  } else {
    performCloseExtractSession(sessionId);
  }
}

export function closeWadExplorerWithFallback() {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  wadExplorer.close();

  // "archive-" sessions are ArchiveEditor-internal — never a fallback target.
  const userExtractSessions = wadExtract.extractSessions.filter(s => !s.embedded);
  const activeUserExtract = wadExtract.activeExtractId
    && userExtractSessions.some(s => s.id === wadExtract.activeExtractId);

  if (projectTab.activeTabId && projectTab.openTabs.find(t => t.id === projectTab.activeTabId)) {
    navigation.setView('preview');
  } else if (activeUserExtract) {
    navigation.setView('extract');
  } else if (projectTab.openTabs.length > 0) {
    projectTab.switchTab(projectTab.openTabs[0].id);
    navigation.setView('preview');
  } else if (userExtractSessions.length > 0) {
    wadExtract.switchSession(userExtractSessions[0].id);
    navigation.setView('extract');
  } else {
    navigation.setView('welcome');
  }
}

/**
 * Close one standalone file-editor tab. If other file tabs remain, stay on the
 * file-editor view (the store already picked a neighbor as active); only when
 * the LAST file tab closes do we fall back to a project/extract/welcome view.
 */
export function closeFileEditorTabWithFallback(tabId: string) {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  const { remaining } = useFileEditorStore.getState().closeTab(tabId);

  if (remaining.length > 0) {
    // Neighbor tab is now active; keep showing the file editor.
    navigation.setView('file-editor');
    return;
  }

  // "archive-" sessions are ArchiveEditor-internal — never a fallback target.
  const userExtractSessions = wadExtract.extractSessions.filter(s => !s.embedded);
  const activeUserExtract = wadExtract.activeExtractId
    && userExtractSessions.some(s => s.id === wadExtract.activeExtractId);

  if (projectTab.activeTabId && projectTab.openTabs.find(t => t.id === projectTab.activeTabId)) {
    navigation.setView('preview');
  } else if (projectTab.openTabs.length > 0) {
    projectTab.switchTab(projectTab.openTabs[0].id);
    navigation.setView('preview');
  } else if (activeUserExtract) {
    navigation.setView('extract');
  } else if (userExtractSessions.length > 0) {
    wadExtract.switchSession(userExtractSessions[0].id);
    navigation.setView('extract');
  } else if (wadExplorer.isOpen) {
    navigation.setView('wad-explorer');
  } else {
    navigation.setView('welcome');
  }
}

/** Close the ACTIVE file-editor tab (back-compat for callers without a tab id). */
export function closeFileEditorWithFallback() {
  const activeId = useFileEditorStore.getState().activeId;
  if (activeId) {
    closeFileEditorTabWithFallback(activeId);
  }
}

export function closeArchiveTabWithFallback(tabId: string) {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const archiveTab = useArchiveTabStore.getState();
  const navigation = useNavigationStore.getState();

  const wasActive = archiveTab.activeArchiveTabId === tabId;
  const { newActiveId, remaining } = archiveTab.removeArchiveTab(tabId);

  if (wasActive || remaining.length === 0) {
    // Extract sessions the ArchiveEditor seeded for its inner WADs use an
    // "archive-" id prefix. They're editor-internal (the ArchiveEditor tears
    // them down on unmount), NOT user-facing WAD-viewer tabs — so they must
    // never be a fallback target, or closing an archive tab after opening an
    // inner WAD/file lands you on a stale/blank extract view instead of going
    // back. Only real WAD-viewer sessions are fallback candidates.
    const userExtractSessions = wadExtract.extractSessions.filter(
      s => !s.embedded,
    );
    const activeUserExtract =
      wadExtract.activeExtractId &&
      userExtractSessions.find(s => s.id === wadExtract.activeExtractId);

    if (remaining.length > 0 && newActiveId) {
      navigation.setView('archive-editor');
    } else if (projectTab.activeTabId && projectTab.openTabs.find(t => t.id === projectTab.activeTabId)) {
      navigation.setView('preview');
    } else if (projectTab.openTabs.length > 0) {
      projectTab.switchTab(projectTab.openTabs[0].id);
      navigation.setView('preview');
    } else if (activeUserExtract) {
      navigation.setView('extract');
    } else if (userExtractSessions.length > 0) {
      wadExtract.switchSession(userExtractSessions[0].id);
      navigation.setView('extract');
    } else if (wadExplorer.isOpen) {
      navigation.setView('wad-explorer');
    } else {
      navigation.setView('welcome');
    }
  }
}

export function openWadExplorer() {
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  wadExplorer.open();
  navigation.setView('wad-explorer');
}

export const navigationCoordinator = {
  removeTabWithFallback,
  closeExtractSessionWithFallback,
  closeWadExplorerWithFallback,
  closeFileEditorWithFallback,
  closeFileEditorTabWithFallback,
  closeArchiveTabWithFallback,
  openWadExplorer,
};
