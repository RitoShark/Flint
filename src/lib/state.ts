/**
 * Flint - React State Management
 * Uses React Context for global state with localStorage persistence
 */

import React, { createContext, useContext, useReducer, useCallback, useEffect, ReactNode } from 'react';
import type { AppState, ModalType, Toast, RecentProject, Project, FileTreeNode, Champion, LogEntry, ContextMenuState, ContextMenuOption, ProjectTab } from './types';

// =============================================================================
// Initial State
// =============================================================================

const initialState: AppState = {
    // App status
    status: 'ready',
    statusMessage: 'Ready',

    // Context menu
    contextMenu: null,

    // Creator info (for repathing)
    creatorName: null,

    // Hash status
    hashesLoaded: false,
    hashCount: 0,

    // League installation
    leaguePath: null,

    // Project state (tab-based)
    openTabs: [],
    activeTabId: null,
    recentProjects: [],

    // UI state
    currentView: 'welcome',
    activeModal: null,
    modalOptions: null,

    // Champions (cached)
    champions: [],
    championsLoaded: false,

    // Toast notifications
    toasts: [],

    // Log panel
    logs: [],
    logPanelExpanded: false,
};

// =============================================================================
// Action Types
// =============================================================================

type Action =
    | { type: 'SET_STATE'; payload: Partial<AppState> }
    | { type: 'SET_STATUS'; payload: { status: AppState['status']; message: string } }
    | { type: 'OPEN_MODAL'; payload: { modal: ModalType; options?: Record<string, unknown> } }
    | { type: 'CLOSE_MODAL' }
    | { type: 'ADD_TOAST'; payload: Toast }
    | { type: 'REMOVE_TOAST'; payload: number }
    // Tab actions
    | { type: 'ADD_TAB'; payload: { project: Project; path: string } }
    | { type: 'REMOVE_TAB'; payload: string }  // tab id
    | { type: 'SWITCH_TAB'; payload: string }  // tab id
    | { type: 'UPDATE_TAB'; payload: { tabId: string; updates: Partial<ProjectTab> } }
    | { type: 'SET_TAB_FILE_TREE'; payload: { tabId: string; fileTree: FileTreeNode | null } }
    | { type: 'TOGGLE_TAB_FOLDER'; payload: { tabId: string; folderPath: string } }
    | { type: 'SET_TAB_SELECTED_FILE'; payload: { tabId: string; filePath: string | null } }
    // Legacy compatibility (redirects to tab actions)
    | { type: 'SET_PROJECT'; payload: { project: Project | null; path: string | null } }
    | { type: 'SET_FILE_TREE'; payload: FileTreeNode | null }
    | { type: 'TOGGLE_FOLDER'; payload: string }
    | { type: 'SET_RECENT_PROJECTS'; payload: RecentProject[] }
    | { type: 'SET_CHAMPIONS'; payload: Champion[] }
    | { type: 'ADD_LOG'; payload: LogEntry }
    | { type: 'CLEAR_LOGS' }
    | { type: 'TOGGLE_LOG_PANEL' }
    | { type: 'OPEN_CONTEXT_MENU'; payload: ContextMenuState }
    | { type: 'CLOSE_CONTEXT_MENU' };

// =============================================================================
// Reducer
// =============================================================================

// Helper to generate unique tab IDs
let tabIdCounter = 0;
function generateTabId(): string {
    return `tab-${Date.now()}-${++tabIdCounter}`;
}

// Helper to get active tab
function getActiveTab(state: AppState): ProjectTab | null {
    if (!state.activeTabId) return null;
    return state.openTabs.find(t => t.id === state.activeTabId) || null;
}

function appReducer(state: AppState, action: Action): AppState {
    switch (action.type) {
        case 'SET_STATE':
            return { ...state, ...action.payload };

        case 'SET_STATUS':
            return {
                ...state,
                status: action.payload.status,
                statusMessage: action.payload.message,
            };

        case 'OPEN_MODAL':
            return {
                ...state,
                activeModal: action.payload.modal,
                modalOptions: action.payload.options || null,
            };

        case 'CLOSE_MODAL':
            return {
                ...state,
                activeModal: null,
                modalOptions: null,
            };

        case 'ADD_TOAST':
            return {
                ...state,
                toasts: [...state.toasts, action.payload],
            };

        case 'REMOVE_TOAST':
            return {
                ...state,
                toasts: state.toasts.filter(t => t.id !== action.payload),
            };

        // =====================================================================
        // Tab Actions
        // =====================================================================

        case 'ADD_TAB': {
            const { project, path } = action.payload;
            // Check if this project is already open
            const existingTab = state.openTabs.find(t => t.projectPath === path);
            if (existingTab) {
                // Switch to existing tab
                return {
                    ...state,
                    activeTabId: existingTab.id,
                    currentView: 'preview',
                };
            }
            // Create new tab
            const newTab: ProjectTab = {
                id: generateTabId(),
                project,
                projectPath: path,
                selectedFile: null,
                fileTree: null,
                expandedFolders: new Set(),
            };
            return {
                ...state,
                openTabs: [...state.openTabs, newTab],
                activeTabId: newTab.id,
                currentView: 'preview',
            };
        }

        case 'REMOVE_TAB': {
            const tabId = action.payload;
            const newTabs = state.openTabs.filter(t => t.id !== tabId);
            let newActiveId: string | null = state.activeTabId;

            // If we closed the active tab, switch to another
            if (state.activeTabId === tabId) {
                const closedIndex = state.openTabs.findIndex(t => t.id === tabId);
                if (newTabs.length > 0) {
                    // Switch to previous tab, or first if we closed the first
                    const newIndex = Math.max(0, closedIndex - 1);
                    newActiveId = newTabs[newIndex]?.id || null;
                } else {
                    newActiveId = null;
                }
            }

            return {
                ...state,
                openTabs: newTabs,
                activeTabId: newActiveId,
                currentView: newActiveId ? state.currentView : 'welcome',
            };
        }

        case 'SWITCH_TAB': {
            const tabId = action.payload;
            const tab = state.openTabs.find(t => t.id === tabId);
            if (!tab) return state;
            return {
                ...state,
                activeTabId: tabId,
                currentView: 'preview',
            };
        }

        case 'UPDATE_TAB': {
            const { tabId, updates } = action.payload;
            return {
                ...state,
                openTabs: state.openTabs.map(t =>
                    t.id === tabId ? { ...t, ...updates } : t
                ),
            };
        }

        case 'SET_TAB_FILE_TREE': {
            const { tabId, fileTree } = action.payload;
            return {
                ...state,
                openTabs: state.openTabs.map(t =>
                    t.id === tabId ? { ...t, fileTree } : t
                ),
            };
        }

        case 'TOGGLE_TAB_FOLDER': {
            const { tabId, folderPath } = action.payload;
            return {
                ...state,
                openTabs: state.openTabs.map(t => {
                    if (t.id !== tabId) return t;
                    const newExpanded = new Set(t.expandedFolders);
                    if (newExpanded.has(folderPath)) {
                        newExpanded.delete(folderPath);
                    } else {
                        newExpanded.add(folderPath);
                    }
                    return { ...t, expandedFolders: newExpanded };
                }),
            };
        }

        case 'SET_TAB_SELECTED_FILE': {
            const { tabId, filePath } = action.payload;
            return {
                ...state,
                openTabs: state.openTabs.map(t =>
                    t.id === tabId ? { ...t, selectedFile: filePath } : t
                ),
            };
        }

        // =====================================================================
        // Legacy Actions (for backward compatibility - operate on active tab)
        // =====================================================================

        case 'SET_PROJECT': {
            const { project, path } = action.payload;
            if (!project || !path) {
                // Close all tabs
                return {
                    ...state,
                    openTabs: [],
                    activeTabId: null,
                    currentView: 'welcome',
                };
            }
            // Redirect to ADD_TAB
            return appReducer(state, { type: 'ADD_TAB', payload: { project, path } });
        }

        case 'SET_FILE_TREE': {
            const activeTab = getActiveTab(state);
            if (!activeTab) return state;
            return appReducer(state, {
                type: 'SET_TAB_FILE_TREE',
                payload: { tabId: activeTab.id, fileTree: action.payload },
            });
        }

        case 'TOGGLE_FOLDER': {
            const activeTab = getActiveTab(state);
            if (!activeTab) return state;
            return appReducer(state, {
                type: 'TOGGLE_TAB_FOLDER',
                payload: { tabId: activeTab.id, folderPath: action.payload },
            });
        }

        case 'SET_RECENT_PROJECTS':
            return {
                ...state,
                recentProjects: action.payload,
            };

        case 'SET_CHAMPIONS':
            return {
                ...state,
                champions: action.payload,
                championsLoaded: true,
            };

        case 'ADD_LOG':
            return {
                ...state,
                logs: [...state.logs, action.payload].slice(-100), // Keep last 100 logs
            };

        case 'CLEAR_LOGS':
            return {
                ...state,
                logs: [],
            };

        case 'TOGGLE_LOG_PANEL':
            return {
                ...state,
                logPanelExpanded: !state.logPanelExpanded,
            };

        case 'OPEN_CONTEXT_MENU':
            return {
                ...state,
                contextMenu: action.payload,
            };

        case 'CLOSE_CONTEXT_MENU':
            return {
                ...state,
                contextMenu: null,
            };

        default:
            return state;
    }
}

// =============================================================================
// Context
// =============================================================================

interface AppContextValue {
    state: AppState;
    dispatch: React.Dispatch<Action>;
    // Convenience methods
    setStatus: (status: AppState['status'], message: string) => void;
    setWorking: (message?: string) => void;
    setReady: (message?: string) => void;
    setError: (message: string) => void;
    openModal: (modal: ModalType, options?: Record<string, unknown>) => void;
    closeModal: () => void;
    showToast: (type: Toast['type'], message: string, options?: { suggestion?: string; duration?: number }) => number;
    dismissToast: (id: number) => void;
    addLog: (level: LogEntry['level'], message: string) => void;
    clearLogs: () => void;
    toggleLogPanel: () => void;
    openContextMenu: (x: number, y: number, options: ContextMenuOption[]) => void;
    closeContextMenu: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

// =============================================================================
// Provider Component
// =============================================================================

const SETTINGS_KEY = 'flint_settings';

interface AppProviderProps {
    children: ReactNode;
}

export function AppProvider({ children }: AppProviderProps) {
    const [state, dispatch] = useReducer(appReducer, initialState, (initial) => {
        // Load persisted settings on init
        try {
            const stored = localStorage.getItem(SETTINGS_KEY);
            if (stored) {
                const settings = JSON.parse(stored);
                return {
                    ...initial,
                    leaguePath: settings.leaguePath || null,
                    recentProjects: settings.recentProjects || [],
                    creatorName: settings.creatorName || null,
                };
            }
        } catch (error) {
            console.error('[Flint] Failed to load settings:', error);
        }
        return initial;
    });

    // Persist settings on change
    useEffect(() => {
        try {
            const settings = {
                leaguePath: state.leaguePath,
                recentProjects: state.recentProjects,
                creatorName: state.creatorName,
            };
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (error) {
            console.error('[Flint] Failed to save settings:', error);
        }
    }, [state.leaguePath, state.recentProjects, state.creatorName]);

    // Toast ID counter
    const toastIdRef = React.useRef(0);

    // Convenience methods
    const setStatus = useCallback((status: AppState['status'], message: string) => {
        dispatch({ type: 'SET_STATUS', payload: { status, message } });
    }, []);

    const setWorking = useCallback((message = 'Working...') => {
        setStatus('working', message);
    }, [setStatus]);

    const setReady = useCallback((message = 'Ready') => {
        setStatus('ready', message);
    }, [setStatus]);

    const setError = useCallback((message: string) => {
        setStatus('error', message);
    }, [setStatus]);

    const openModal = useCallback((modal: ModalType, options?: Record<string, unknown>) => {
        dispatch({ type: 'OPEN_MODAL', payload: { modal, options } });
    }, []);

    const closeModal = useCallback(() => {
        dispatch({ type: 'CLOSE_MODAL' });
    }, []);

    const showToast = useCallback((
        type: Toast['type'],
        message: string,
        options: { suggestion?: string; duration?: number } = {}
    ) => {
        const id = ++toastIdRef.current;
        const toast: Toast = {
            id,
            type,
            message,
            suggestion: options.suggestion || null,
            timestamp: Date.now(),
        };
        dispatch({ type: 'ADD_TOAST', payload: toast });

        // Auto-dismiss
        const duration = options.duration !== undefined ? options.duration : 5000;
        if (duration > 0) {
            setTimeout(() => dispatch({ type: 'REMOVE_TOAST', payload: id }), duration);
        }

        return id;
    }, []);

    const dismissToast = useCallback((id: number) => {
        dispatch({ type: 'REMOVE_TOAST', payload: id });
    }, []);

    // Log ID counter
    const logIdRef = React.useRef(0);

    const addLog = useCallback((level: LogEntry['level'], message: string) => {
        const log: LogEntry = {
            id: ++logIdRef.current,
            timestamp: Date.now(),
            level,
            message,
        };
        dispatch({ type: 'ADD_LOG', payload: log });
    }, []);

    const clearLogs = useCallback(() => {
        dispatch({ type: 'CLEAR_LOGS' });
    }, []);

    const toggleLogPanel = useCallback(() => {
        dispatch({ type: 'TOGGLE_LOG_PANEL' });
    }, []);

    const openContextMenu = useCallback((x: number, y: number, options: ContextMenuOption[]) => {
        dispatch({ type: 'OPEN_CONTEXT_MENU', payload: { x, y, options } });
    }, []);

    const closeContextMenu = useCallback(() => {
        dispatch({ type: 'CLOSE_CONTEXT_MENU' });
    }, []);

    const value: AppContextValue = {
        state,
        dispatch,
        setStatus,
        setWorking,
        setReady,
        setError,
        openModal,
        closeModal,
        showToast,
        dismissToast,
        addLog,
        clearLogs,
        toggleLogPanel,
        openContextMenu,
        closeContextMenu,
    };

    return React.createElement(AppContext.Provider, { value }, children);
}

// =============================================================================
// Hook
// =============================================================================

export function useAppState() {
    const context = useContext(AppContext);
    if (!context) {
        throw new Error('useAppState must be used within an AppProvider');
    }
    return context;
}

// =============================================================================
// Image Cache (LRU for decoded DDS images)
// =============================================================================

const IMAGE_CACHE_MAX_SIZE = 50;
const imageCache = new Map<string, unknown>();

export function getCachedImage(path: string): unknown | null {
    const cached = imageCache.get(path);
    if (cached) {
        // Move to end (most recently used)
        imageCache.delete(path);
        imageCache.set(path, cached);
        console.log('[Flint] Image cache hit:', path);
        return cached;
    }
    return null;
}

export function cacheImage(path: string, imageData: unknown): void {
    // Evict oldest if at capacity
    if (imageCache.size >= IMAGE_CACHE_MAX_SIZE) {
        const oldestKey = imageCache.keys().next().value;
        if (oldestKey) {
            imageCache.delete(oldestKey);
            console.log('[Flint] Image cache evicted:', oldestKey);
        }
    }
    imageCache.set(path, imageData);
    console.log('[Flint] Image cached:', path, `(${imageCache.size}/${IMAGE_CACHE_MAX_SIZE})`);
}

export function clearImageCache(): void {
    imageCache.clear();
    console.log('[Flint] Image cache cleared');
}
