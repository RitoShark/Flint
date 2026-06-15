import { useProjectTabStore } from './projectTabStore';
import { useWadExtractStore } from './wadExtractStore';
import { useWadExplorerStore } from './wadExplorerStore';
import { useNavigationStore } from './navigationStore';
import { useFileEditorStore } from './fileEditorStore';

export function removeTabWithFallback(tabId: string) {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  const { newActiveId, remainingTabs } = projectTab.removeTab(tabId);

  if (projectTab.activeTabId === tabId || remainingTabs.length === 0) {
    if (remainingTabs.length > 0 && newActiveId) {
      navigation.setView('preview');
    } else if (wadExtract.extractSessions.length > 0) {
      const sessionId = wadExtract.activeExtractId ?? wadExtract.extractSessions[0].id;
      wadExtract.switchSession(sessionId);
      navigation.setView('extract');
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

  if (wadExtract.activeExtractId === sessionId || remainingSessions.length === 0) {
    if (remainingSessions.length > 0 && newActiveId) {
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

  if (projectTab.activeTabId && projectTab.openTabs.find(t => t.id === projectTab.activeTabId)) {
    navigation.setView('preview');
  } else if (wadExtract.activeExtractId && wadExtract.extractSessions.find(s => s.id === wadExtract.activeExtractId)) {
    navigation.setView('extract');
  } else if (projectTab.openTabs.length > 0) {
    projectTab.switchTab(projectTab.openTabs[0].id);
    navigation.setView('preview');
  } else if (wadExtract.extractSessions.length > 0) {
    wadExtract.switchSession(wadExtract.extractSessions[0].id);
    navigation.setView('extract');
  } else {
    navigation.setView('welcome');
  }
}

export function closeFileEditorWithFallback() {
  const projectTab = useProjectTabStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const navigation = useNavigationStore.getState();

  useFileEditorStore.getState().closeTarget();

  if (projectTab.activeTabId && projectTab.openTabs.find(t => t.id === projectTab.activeTabId)) {
    navigation.setView('preview');
  } else if (projectTab.openTabs.length > 0) {
    projectTab.switchTab(projectTab.openTabs[0].id);
    navigation.setView('preview');
  } else if (wadExtract.activeExtractId && wadExtract.extractSessions.find(s => s.id === wadExtract.activeExtractId)) {
    navigation.setView('extract');
  } else if (wadExtract.extractSessions.length > 0) {
    wadExtract.switchSession(wadExtract.extractSessions[0].id);
    navigation.setView('extract');
  } else if (wadExplorer.isOpen) {
    navigation.setView('wad-explorer');
  } else {
    navigation.setView('welcome');
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
  openWadExplorer,
};
