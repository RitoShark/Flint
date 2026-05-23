/**
 * Root Store Index
 * Combines all domain stores and provides backward-compatible useAppState() hook
 */

import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppMetadataStore } from './appMetadataStore';
import { useConfigStore } from './configStore';
import { useUxStore } from './uxStore';
import { useProjectTabStore } from './projectTabStore';
import { useNavigationStore } from './navigationStore';
import { useWadExtractStore } from './wadExtractStore';
import { useWadExplorerStore } from './wadExplorerStore';
import { useChampionStore } from './championStore';
import { useModalStore } from './modalStore';
import { useFileEditorStore } from './fileEditorStore';
import { useNotificationStore } from './notificationStore';
import { navigationCoordinator } from './navigationCoordinator';
import type { AppState } from '../types';

// Re-export individual stores
export {
  useAppMetadataStore,
  useConfigStore,
  useUxStore,
  useProjectTabStore,
  useNavigationStore,
  useWadExtractStore,
  useWadExplorerStore,
  useChampionStore,
  useModalStore,
  useNotificationStore,
  useFileEditorStore,
};

/**
 * Combined hook that provides backward compatibility with the old useAppState() API
 * Components can continue using state.xyz pattern or migrate to individual stores.
 *
 * IMPORTANT — performance: each store is subscribed via a `useShallow`
 * selector that picks ONLY the fields surfaced through the combined `state`
 * object. Without this, calling `useAppMetadataStore()` (no selector)
 * subscribes the consumer to the entire store snapshot, so any field change
 * (a new log line, a toast, a heartbeat) re-renders every component that
 * reads `useAppState()`. With ~22 callsites including TitleBar/StatusBar
 * (always mounted), that cascade was the dominant cause of the
 * "delay between commands" sluggishness.
 *
 * Action method refs are stable by zustand contract, so we read them via
 * `getState()` rather than subscribing to them.
 */
export function useAppState() {
  // Subscribed field subsets — drive the `state` object below. Each call
  // uses `useShallow` so the consumer only re-renders when one of the
  // listed fields actually changes (rather than on any field-or-method
  // change in the store, which is what bare `useXxxStore()` would do).
  // NOTE: `logs` and `logPanelExpanded` are intentionally NOT in this subset.
  // Backend tracing events flush to the logs array every 250ms; including
  // them here would re-render every `useAppState()` consumer (TitleBar,
  // StatusBar, modals, ~25 components) on every flush. LogPanel subscribes
  // to those fields directly via `useAppMetadataStore((s) => s.logs)`.
  const appMetadataSubset = useAppMetadataStore(
    useShallow((s) => ({
      status: s.status,
      statusMessage: s.statusMessage,
      hashesLoaded: s.hashesLoaded,
      hashCount: s.hashCount,
      verboseLogging: s.verboseLogging,
    })),
  );
  const configSubset = useConfigStore(
    useShallow((s) => ({
      leaguePath: s.leaguePath,
      leaguePathPbe: s.leaguePathPbe,
      defaultProjectPath: s.defaultProjectPath,
      creatorName: s.creatorName,
      creatorDescription: s.creatorDescription,
      creatorHome: s.creatorHome,
      creatorTip: s.creatorTip,
      autoUpdateEnabled: s.autoUpdateEnabled,
      skippedUpdateVersion: s.skippedUpdateVersion,
      ltkManagerModPath: s.ltkManagerModPath,
      autoSyncToLauncher: s.autoSyncToLauncher,
      celestialModPath: s.celestialModPath,
      preferredLauncher: s.preferredLauncher,
      recentProjects: s.recentProjects,
      savedProjects: s.savedProjects,
    })),
  );
  const projectTabSubset = useProjectTabStore(
    useShallow((s) => ({
      openTabs: s.openTabs,
      activeTabId: s.activeTabId,
    })),
  );
  const navigationSubset = useNavigationStore(
    useShallow((s) => ({ currentView: s.currentView })),
  );
  const wadExtractSubset = useWadExtractStore(
    useShallow((s) => ({
      extractSessions: s.extractSessions,
      activeExtractId: s.activeExtractId,
    })),
  );
  const wadExplorerSubset = useWadExplorerStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      wads: s.wads,
      scanStatus: s.scanStatus,
      scanError: s.scanError,
      selected: s.selected,
      expandedWads: s.expandedWads,
      expandedFolders: s.expandedFolders,
      searchQuery: s.searchQuery,
      checkedFiles: s.checkedFiles,
      checkedCountPerWad: s.checkedCountPerWad,
    })),
  );
  const championSubset = useChampionStore(
    useShallow((s) => ({
      champions: s.champions,
      championsLoaded: s.championsLoaded,
    })),
  );
  const modalSubset = useModalStore(
    useShallow((s) => ({
      activeModal: s.activeModal,
      modalOptions: s.modalOptions,
      confirmDialog: s.confirmDialog,
      contextMenu: s.contextMenu,
    })),
  );
  const notificationSubset = useNotificationStore(
    useShallow((s) => ({ toasts: s.toasts })),
  );

  // Action snapshots — method refs are stable in zustand, so reading off
  // getState() once per render is safe and avoids unnecessary subscriptions.
  // Names match the legacy bundles so the dispatch switch and return below
  // need no changes.
  const appMetadata = useAppMetadataStore.getState();
  const config = useConfigStore.getState();
  const projectTab = useProjectTabStore.getState();
  const navigation = useNavigationStore.getState();
  const wadExtract = useWadExtractStore.getState();
  const wadExplorer = useWadExplorerStore.getState();
  const champion = useChampionStore.getState();
  const modal = useModalStore.getState();
  const notification = useNotificationStore.getState();

  // Combined state object (for components that read state.xyz). Built from
  // the subscribed `*Subset` bundles so this object is stable when none of
  // the picked fields changed. Wrapped in useMemo so the outer reference
  // is stable too — without this, every render returned a fresh literal
  // and React.memo on consumers receiving `state` (or destructured pieces)
  // saw "new" props every dispatch.
  const state: AppState = React.useMemo(() => ({
    // App metadata
    status: appMetadataSubset.status,
    statusMessage: appMetadataSubset.statusMessage,
    hashesLoaded: appMetadataSubset.hashesLoaded,
    hashCount: appMetadataSubset.hashCount,
    verboseLogging: appMetadataSubset.verboseLogging,
    // logs/logPanelExpanded read off the live store snapshot — they're not
    // subscribed in `appMetadataSubset` (would cascade re-renders to every
    // useAppState consumer on each 250ms log flush). The few callers that
    // actually read these from `state` get a fresh value on the renders that
    // are triggered by *other* fields they care about; live consumers should
    // subscribe directly via useAppMetadataStore.
    logs: appMetadata.logs,
    logPanelExpanded: appMetadata.logPanelExpanded,

    // Config
    leaguePath: configSubset.leaguePath,
    leaguePathPbe: configSubset.leaguePathPbe,
    defaultProjectPath: configSubset.defaultProjectPath,
    creatorName: configSubset.creatorName,
    creatorDescription: configSubset.creatorDescription,
    creatorHome: configSubset.creatorHome,
    creatorTip: configSubset.creatorTip,
    autoUpdateEnabled: configSubset.autoUpdateEnabled,
    skippedUpdateVersion: configSubset.skippedUpdateVersion,
    ltkManagerModPath: configSubset.ltkManagerModPath,
    autoSyncToLauncher: configSubset.autoSyncToLauncher,
    celestialModPath: configSubset.celestialModPath,
    preferredLauncher: configSubset.preferredLauncher,

    // Project tabs
    openTabs: projectTabSubset.openTabs,
    activeTabId: projectTabSubset.activeTabId,
    recentProjects: configSubset.recentProjects,
    savedProjects: configSubset.savedProjects,

    // File change tracking
    fileChanges: {},

    // Navigation
    currentView: navigationSubset.currentView,

    // WAD extract
    extractSessions: wadExtractSubset.extractSessions,
    activeExtractId: wadExtractSubset.activeExtractId,

    // WAD explorer
    wadExplorer: {
      isOpen: wadExplorerSubset.isOpen,
      wads: wadExplorerSubset.wads,
      scanStatus: wadExplorerSubset.scanStatus,
      scanError: wadExplorerSubset.scanError,
      selected: wadExplorerSubset.selected,
      expandedWads: wadExplorerSubset.expandedWads,
      expandedFolders: wadExplorerSubset.expandedFolders,
      searchQuery: wadExplorerSubset.searchQuery,
      checkedFiles: wadExplorerSubset.checkedFiles,
      checkedCountPerWad: wadExplorerSubset.checkedCountPerWad,
    },

    // Champions
    champions: championSubset.champions,
    championsLoaded: championSubset.championsLoaded,

    // Modals
    activeModal: modalSubset.activeModal,
    modalOptions: modalSubset.modalOptions,
    confirmDialog: modalSubset.confirmDialog,
    contextMenu: modalSubset.contextMenu,

    // Notifications
    toasts: notificationSubset.toasts,
  }), [
    appMetadataSubset,
    configSubset,
    projectTabSubset,
    navigationSubset,
    wadExtractSubset,
    wadExplorerSubset,
    championSubset,
    modalSubset,
    notificationSubset,
    appMetadata.logs,
    appMetadata.logPanelExpanded,
  ]);

  // Legacy dispatch function for backward compatibility
  // Maps old action types to new store calls
  const dispatch = (action: any) => {
    switch (action.type) {
      // App metadata
      case 'SET_STATUS':
        appMetadata.setStatus(action.payload.status, action.payload.message);
        break;
      case 'ADD_LOG':
        appMetadata.addLog(action.payload.level, action.payload.message);
        break;
      case 'CLEAR_LOGS':
        appMetadata.clearLogs();
        break;
      case 'TOGGLE_LOG_PANEL':
        appMetadata.toggleLogPanel();
        break;

      // Modals
      case 'OPEN_MODAL':
        modal.openModal(action.payload.modal, action.payload.options);
        break;
      case 'CLOSE_MODAL':
        modal.closeModal();
        break;
      case 'OPEN_CONTEXT_MENU':
        modal.openContextMenu(action.payload.x, action.payload.y, action.payload.options);
        break;
      case 'CLOSE_CONTEXT_MENU':
        modal.closeContextMenu();
        break;
      case 'OPEN_CONFIRM_DIALOG':
        modal.openConfirmDialog(action.payload);
        break;
      case 'CLOSE_CONFIRM_DIALOG':
        modal.closeConfirmDialog();
        break;

      // Notifications
      case 'ADD_TOAST':
        notification.showToast(action.payload.type, action.payload.message, { suggestion: action.payload.suggestion });
        break;
      case 'REMOVE_TOAST':
        notification.dismissToast(action.payload);
        break;

      // Project tabs
      case 'ADD_TAB':
        projectTab.addTab(action.payload.project, action.payload.path);
        navigation.setView('preview');
        break;
      case 'REMOVE_TAB':
        navigationCoordinator.removeTabWithFallback(action.payload);
        break;
      case 'SWITCH_TAB':
        projectTab.switchTab(action.payload);
        navigation.setView('preview');
        break;
      case 'UPDATE_TAB':
        projectTab.updateTab(action.payload.tabId, action.payload.updates);
        break;
      case 'SET_TAB_FILE_TREE':
        projectTab.setFileTree(action.payload.tabId, action.payload.fileTree);
        break;
      case 'TOGGLE_TAB_FOLDER':
        projectTab.toggleFolder(action.payload.tabId, action.payload.folderPath);
        break;
      case 'SET_TAB_SELECTED_FILE':
        projectTab.setSelectedFile(action.payload.tabId, action.payload.filePath);
        break;

      // Legacy project actions (redirect to tab actions)
      case 'SET_PROJECT':
        if (action.payload.project && action.payload.path) {
          projectTab.addTab(action.payload.project, action.payload.path);
          navigation.setView('preview');

          // Auto-save to saved projects list
          const proj = action.payload.project;
          config.addSavedProject({
            id: `proj-${Date.now()}`,
            name: proj.display_name || proj.name,
            kind: proj.kind ?? 'skin',
            champion: proj.champion,
            mapId: proj.map_id ?? null,
            path: action.payload.path,
            lastOpened: new Date().toISOString(),
          });
        } else {
          // Close all tabs
          projectTab.openTabs.forEach(t => navigationCoordinator.removeTabWithFallback(t.id));
        }
        break;
      case 'SET_FILE_TREE':
        // Use getState() to get current activeTabId, not captured value
        const currentTabId = useProjectTabStore.getState().activeTabId;
        if (currentTabId) {
          useProjectTabStore.getState().setFileTree(currentTabId, action.payload);
        }
        break;
      case 'TOGGLE_FOLDER':
        {
          const currentTabId = useProjectTabStore.getState().activeTabId;
          if (currentTabId) {
            useProjectTabStore.getState().toggleFolder(currentTabId, action.payload);
          }
        }
        break;
      case 'BULK_SET_FOLDERS':
        {
          const currentTabId = useProjectTabStore.getState().activeTabId;
          if (currentTabId) {
            useProjectTabStore.getState().bulkSetFolders(currentTabId, action.payload.paths, action.payload.expand);
          }
        }
        break;

      // Config
      case 'SET_RECENT_PROJECTS':
        config.setRecentProjects(action.payload);
        break;
      case 'ADD_SAVED_PROJECT':
        config.addSavedProject(action.payload);
        break;
      case 'REMOVE_SAVED_PROJECT':
        config.removeSavedProject(action.payload);
        break;

      // Champions
      case 'SET_CHAMPIONS':
        champion.setChampions(action.payload);
        break;

      // WAD Explorer
      case 'OPEN_WAD_EXPLORER':
        navigationCoordinator.openWadExplorer();
        break;
      case 'CLOSE_WAD_EXPLORER':
        navigationCoordinator.closeWadExplorerWithFallback();
        break;
      case 'SET_WAD_EXPLORER_SCAN':
        wadExplorer.setScan(action.payload.status, action.payload.wads, action.payload.error);
        break;
      case 'SET_WAD_EXPLORER_WAD_STATUS':
        wadExplorer.setWadStatus(action.payload.wadPath, action.payload.status, action.payload.chunks, action.payload.error);
        break;
      case 'BATCH_SET_WAD_STATUSES':
        wadExplorer.batchSetWadStatuses(action.payload);
        break;
      case 'SET_WAD_EXPLORER_SELECTED':
        if (action.payload) {
          wadExplorer.setSelected(action.payload.wadPath, action.payload.hash);
        } else {
          wadExplorer.setSelected(null, null);
        }
        break;
      case 'TOGGLE_WAD_EXPLORER_WAD':
        wadExplorer.toggleWad(action.payload);
        break;
      case 'TOGGLE_WAD_EXPLORER_FOLDER':
        wadExplorer.toggleFolder(action.payload);
        break;
      case 'BULK_SET_WAD_EXPLORER_FOLDERS':
        wadExplorer.bulkSetFolders(action.payload.keys, action.payload.expand);
        break;
      case 'SET_WAD_EXPLORER_SEARCH':
        wadExplorer.setSearch(action.payload);
        break;
      case 'WAD_EXPLORER_TOGGLE_CHECK':
        wadExplorer.toggleCheck(action.payload.keys, action.payload.checked);
        break;
      case 'WAD_EXPLORER_CLEAR_CHECKS':
        wadExplorer.clearChecks();
        break;

      // Extract sessions
      case 'OPEN_EXTRACT_SESSION':
        wadExtract.openSession(action.payload.id, action.payload.wadPath);
        navigation.setView('extract');
        break;
      case 'CLOSE_EXTRACT_SESSION':
        navigationCoordinator.closeExtractSessionWithFallback(action.payload);
        break;
      case 'SWITCH_EXTRACT_TAB':
        wadExtract.switchSession(action.payload);
        navigation.setView('extract');
        break;
      case 'SET_EXTRACT_CHUNKS':
        wadExtract.setChunks(action.payload.sessionId, action.payload.chunks);
        break;
      case 'SET_EXTRACT_PREVIEW':
        wadExtract.setPreview(action.payload.sessionId, action.payload.hash);
        break;
      case 'TOGGLE_EXTRACT_FOLDER':
        wadExtract.toggleFolder(action.payload.sessionId, action.payload.folderPath);
        break;
      case 'TOGGLE_EXTRACT_CHUNK':
        wadExtract.toggleChunk(action.payload.sessionId, action.payload.hash);
        break;
      case 'SET_EXTRACT_SEARCH':
        wadExtract.setSearch(action.payload.sessionId, action.payload.query);
        break;
      case 'SET_EXTRACT_LOADING':
        wadExtract.setLoading(action.payload.sessionId, action.payload.loading);
        break;

      // Generic SET_STATE for partial updates
      case 'SET_STATE':
        if (action.payload.status !== undefined) appMetadata.setStatus(action.payload.status, action.payload.statusMessage || '');
        if (action.payload.hashesLoaded !== undefined) appMetadata.setHashInfo(action.payload.hashesLoaded, action.payload.hashCount || 0);
        if (action.payload.verboseLogging !== undefined) appMetadata.setVerboseLogging(action.payload.verboseLogging);
        if (action.payload.leaguePath !== undefined) config.setLeaguePath(action.payload.leaguePath);
        if (action.payload.leaguePathPbe !== undefined) config.setLeaguePathPbe(action.payload.leaguePathPbe);
        if (action.payload.defaultProjectPath !== undefined) config.setDefaultProjectPath(action.payload.defaultProjectPath);
        if (action.payload.creatorName !== undefined) config.setCreatorName(action.payload.creatorName);
        if (action.payload.creatorDescription !== undefined) config.setCreatorDescription(action.payload.creatorDescription);
        if (action.payload.creatorHome !== undefined) config.setCreatorHome(action.payload.creatorHome);
        if (action.payload.creatorTip !== undefined) config.setCreatorTip(action.payload.creatorTip);
        if (action.payload.autoUpdateEnabled !== undefined) config.setAutoUpdateEnabled(action.payload.autoUpdateEnabled);
        if (action.payload.skippedUpdateVersion !== undefined) config.setSkippedUpdateVersion(action.payload.skippedUpdateVersion);
        if (action.payload.ltkManagerModPath !== undefined) config.setLtkManagerModPath(action.payload.ltkManagerModPath);
        if (action.payload.autoSyncToLauncher !== undefined) config.setAutoSyncToLauncher(action.payload.autoSyncToLauncher);
        if (action.payload.celestialModPath !== undefined) config.setCelestialModPath(action.payload.celestialModPath);
        if (action.payload.preferredLauncher !== undefined) config.setPreferredLauncher(action.payload.preferredLauncher);
        if (action.payload.currentView !== undefined) navigation.setView(action.payload.currentView);
        break;

      default:
        console.warn('[Zustand Migration] Unknown action type:', action.type);
    }
  };

  return {
    state,
    dispatch, // Legacy dispatch for backward compatibility

    // Convenience methods (delegate to appropriate stores)
    setStatus: appMetadata.setStatus,
    setWorking: appMetadata.setWorking,
    setReady: appMetadata.setReady,
    setError: appMetadata.setError,
    openModal: modal.openModal,
    closeModal: modal.closeModal,
    showToast: notification.showToast,
    dismissToast: notification.dismissToast,
    addLog: appMetadata.addLog,
    clearLogs: appMetadata.clearLogs,
    toggleLogPanel: appMetadata.toggleLogPanel,
    openContextMenu: modal.openContextMenu,
    closeContextMenu: modal.closeContextMenu,
    openConfirmDialog: modal.openConfirmDialog,
    closeConfirmDialog: modal.closeConfirmDialog,

    // Direct store access (for components that want to use individual stores)
    stores: {
      appMetadata,
      config,
      projectTab,
      navigation,
      wadExtract,
      wadExplorer,
      champion,
      modal,
      notification,
    },
  };
}

/**
 * Legacy AppProvider component for backward compatibility
 * With Zustand, we don't need a provider at the root, but we keep this
 * export to avoid breaking components that import AppProvider
 */
export function AppProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(React.Fragment, null, children);
}
