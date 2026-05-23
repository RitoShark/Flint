/**
 * Navigation Coordinator
 * Orchestrates complex cross-store navigation logic (tab/session closing with fallback)
 */

import { useProjectTabStore } from './projectTabStore';
import { useWadExtractStore } from './wadExtractStore';
import { useWadExplorerStore } from './wadExplorerStore';
import { useNavigationStore } from './navigationStore';

/**
 * Remove a project tab and handle fallback navigation
 * Fallback order: other tabs → extract sessions → WAD explorer → welcome
 */
export function removeTabWithFallback(tabId: string) {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  // Remove the tab
  const { newActiveId, remainingTabs } = projectTab.removeTab(tabId);

  // Determine fallback view (only if this was the active tab)
  if (projectTab.activeTabId === tabId || remainingTabs.length === 0) {
    if (remainingTabs.length > 0 && newActiveId) {
      // Switch to another project tab
      navigation.setView('preview');
    } else if (wadExtract.extractSessions.length > 0) {
      // Fall back to an extract session
      const sessionId = wadExtract.activeExtractId ?? wadExtract.extractSessions[0].id;
      wadExtract.switchSession(sessionId);
      navigation.setView('extract');
    } else if (wadExplorer.isOpen) {
      // Fall back to WAD explorer
      navigation.setView('wad-explorer');
    } else {
      // Fall back to welcome screen
      navigation.setView('welcome');
    }
  }
}

function performCloseExtractSession(sessionId: string) {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  // Close the session
  const { newActiveId, remainingSessions } = wadExtract.closeSession(sessionId);

  // Determine fallback view (only if this was the active session)
  if (wadExtract.activeExtractId === sessionId || remainingSessions.length === 0) {
    if (remainingSessions.length > 0 && newActiveId) {
      // Switch to another extract session
      navigation.setView('extract');
    } else if (projectTab.activeTabId && projectTab.openTabs.find(t => t.id === projectTab.activeTabId)) {
      // Fall back to the active project tab
      navigation.setView('preview');
    } else if (projectTab.openTabs.length > 0) {
      // Fall back to first project tab
      projectTab.switchTab(projectTab.openTabs[0].id);
      navigation.setView('preview');
    } else if (wadExplorer.isOpen) {
      // Fall back to WAD explorer
      navigation.setView('wad-explorer');
    } else {
      // Fall back to welcome screen
      navigation.setView('welcome');
    }
  }
}

/**
 * Close an extract session and handle fallback navigation
 * Fallback order: other extract sessions → active project tab → WAD explorer → welcome
 */
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
        onConfirm: (confirmed) => {
          if (confirmed) {
            performCloseExtractSession(sessionId);
          }
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

/**
 * Close the WAD Explorer and handle fallback navigation
 * Fallback order: active project tab → active extract session → first available tab/session → welcome
 */
export function closeWadExplorerWithFallback() {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  // Close the WAD explorer
  wadExplorer.close();

  // Determine fallback view using last active pointers
  if (projectTab.activeTabId && projectTab.openTabs.find(t => t.id === projectTab.activeTabId)) {
    // Fall back to the last active project tab
    navigation.setView('preview');
  } else if (wadExtract.activeExtractId && wadExtract.extractSessions.find(s => s.id === wadExtract.activeExtractId)) {
    // Fall back to the last active extract session
    navigation.setView('extract');
  } else if (projectTab.openTabs.length > 0) {
    // Fall back to first project tab
    projectTab.switchTab(projectTab.openTabs[0].id);
    navigation.setView('preview');
  } else if (wadExtract.extractSessions.length > 0) {
    // Fall back to first extract session
    wadExtract.switchSession(wadExtract.extractSessions[0].id);
    navigation.setView('extract');
  } else {
    // Fall back to welcome screen
    navigation.setView('welcome');
  }
}

/**
 * Open the WAD Explorer
 */
export function openWadExplorer() {
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  wadExplorer.open();
  navigation.setView('wad-explorer');
}

/**
 * Export coordinator functions as a namespace
 */
export const navigationCoordinator = {
  removeTabWithFallback,
  closeExtractSessionWithFallback,
  closeWadExplorerWithFallback,
  openWadExplorer,
};
