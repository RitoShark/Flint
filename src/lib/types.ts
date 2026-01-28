/**
 * Flint - TypeScript Type Definitions
 */

// =============================================================================
// Application State Types
// =============================================================================

export type AppStatus = 'ready' | 'working' | 'error';
export type ModalType = 'newProject' | 'settings' | 'export' | 'firstTimeSetup' | 'updateAvailable' | null;
export type ViewType = 'welcome' | 'preview' | 'editor' | 'project';

export interface Toast {
    id: number;
    type: 'info' | 'success' | 'warning' | 'error';
    message: string;
    suggestion?: string | null;
    timestamp: number;
}

export interface LogEntry {
    id: number;
    timestamp: number;
    level: 'info' | 'warning' | 'error';
    message: string;
}

export interface RecentProject {
    name: string;
    champion: string;
    skin: number;
    path: string;
    lastOpened: string;
}

export interface FileTreeNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileTreeNode[];
}

export interface Project {
    name: string;
    display_name?: string;
    champion: string;
    skin_id: number;
    creator?: string;
    version?: string;
    description?: string;
    project_path?: string;
}

export interface Champion {
    id: string;
    name: string;
    skins: Skin[];
}

export interface Skin {
    id: number;
    name: string;
    chromas?: Chroma[];
}

export interface Chroma {
    id: number;
    name: string;
}

export interface AppState {
    // App status
    status: AppStatus;
    statusMessage: string;

    // Creator info (for repathing)
    creatorName: string | null;

    // Hash status
    hashesLoaded: boolean;
    hashCount: number;

    // League installation
    leaguePath: string | null;

    // Project state
    currentProject: Project | null;
    currentProjectPath: string | null;
    recentProjects: RecentProject[];

    // UI state
    selectedFile: string | null;
    currentView: ViewType;
    activeModal: ModalType;
    modalOptions: Record<string, unknown> | null;

    // File tree
    fileTree: FileTreeNode | null;
    expandedFolders: Set<string>;

    // Champions (cached)
    champions: Champion[];
    championsLoaded: boolean;

    // Toast notifications
    toasts: Toast[];

    // Log panel
    logs: LogEntry[];
    logPanelExpanded: boolean;
}

// =============================================================================
// API Response Types
// =============================================================================

export interface HashStatus {
    loaded_count: number;
}

export interface LeagueDetectResult {
    path: string | null;
}

export interface ExportProgress {
    stage: string;
    current: number;
    total: number;
}

export interface UpdateInfo {
    available: boolean;
    current_version: string;
    latest_version: string;
    release_notes: string;
    download_url: string;
    published_at: string;
}
