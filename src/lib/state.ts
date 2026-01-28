/**
 * Flint - React State Management
 * Uses React Context for global state with localStorage persistence
 */

import React, { createContext, useContext, useReducer, useCallback, useEffect, ReactNode } from 'react';
import type { AppState, ModalType, Toast, RecentProject, Project, FileTreeNode, Champion, LogEntry } from './types';

// =============================================================================
// Initial State
// =============================================================================

const initialState: AppState = {
    // App status
    status: 'ready',
    statusMessage: 'Ready',

    // Creator info (for repathing)
    creatorName: null,

    // Hash status
    hashesLoaded: false,
    hashCount: 0,

    // League installation
    leaguePath: null,

    // Project state
    currentProject: null,
    currentProjectPath: null,
    recentProjects: [],

    // UI state
    selectedFile: null,
    currentView: 'welcome',
    activeModal: null,
    modalOptions: null,

    // File tree
    fileTree: null,
    expandedFolders: new Set(),

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
    | { type: 'SET_PROJECT'; payload: { project: Project | null; path: string | null } }
    | { type: 'SET_FILE_TREE'; payload: FileTreeNode | null }
    | { type: 'TOGGLE_FOLDER'; payload: string }
    | { type: 'SET_RECENT_PROJECTS'; payload: RecentProject[] }
    | { type: 'SET_CHAMPIONS'; payload: Champion[] }
    | { type: 'ADD_LOG'; payload: LogEntry }
    | { type: 'CLEAR_LOGS' }
    | { type: 'TOGGLE_LOG_PANEL' };

// =============================================================================
// Reducer
// =============================================================================

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

        case 'SET_PROJECT':
            return {
                ...state,
                currentProject: action.payload.project,
                currentProjectPath: action.payload.path,
                currentView: action.payload.project ? 'preview' : 'welcome',
                selectedFile: null,
            };

        case 'SET_FILE_TREE':
            return {
                ...state,
                fileTree: action.payload,
            };

        case 'TOGGLE_FOLDER': {
            const newExpanded = new Set(state.expandedFolders);
            if (newExpanded.has(action.payload)) {
                newExpanded.delete(action.payload);
            } else {
                newExpanded.add(action.payload);
            }
            return { ...state, expandedFolders: newExpanded };
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
