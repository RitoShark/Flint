/**
 * Flint - TypeScript Type Definitions
 */

// =============================================================================
// Application State Types
// =============================================================================

export type AppStatus = 'ready' | 'working' | 'error';
export type ModalType = 'newProject' | 'settings' | 'export' | 'firstTimeSetup' | 'updateAvailable' | 'recolor' | 'checkpoint' | null;
export type ViewType = 'welcome' | 'preview' | 'editor' | 'project' | 'checkpoints';

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

export interface ContextMenuState {
    x: number;
    y: number;
    options: ContextMenuOption[];
}

export interface ContextMenuOption {
    label: string;
    icon?: string;
    onClick: () => void;
    danger?: boolean;
}

export interface ProjectTab {
    id: string;
    project: Project;
    projectPath: string;
    selectedFile: string | null;
    fileTree: FileTreeNode | null;
    expandedFolders: Set<string>;
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

    // Project state (tab-based)
    openTabs: ProjectTab[];
    activeTabId: string | null;
    recentProjects: RecentProject[];

    // UI state
    currentView: ViewType;
    activeModal: ModalType;
    modalOptions: Record<string, unknown> | null;

    // Champions (cached)
    champions: Champion[];
    championsLoaded: boolean;

    // Toast notifications
    toasts: Toast[];

    // Log panel
    logs: LogEntry[];
    logPanelExpanded: boolean;

    // Context menu
    contextMenu: ContextMenuState | null;
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

// =============================================================================
// Checkpoint Types
// =============================================================================

export type AssetType = 'Texture' | 'Model' | 'Animation' | 'Bin' | 'Audio' | 'Data' | 'Unknown';

export interface FileEntry {
    path: string;
    hash: string;
    size: number;
    asset_type: AssetType;
}

export interface Checkpoint {
    id: string;
    timestamp: string; // ISO 8601
    message: string;
    author?: string;
    tags: string[];
    file_manifest: Record<string, FileEntry>;
}

export interface CheckpointDiff {
    added: FileEntry[];
    modified: [FileEntry, FileEntry][];
    deleted: FileEntry[];
}
