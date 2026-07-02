// =============================================================================
// Application State Types
// =============================================================================

export type AppStatus = 'ready' | 'working' | 'error';
export type ModalType = 'newProject' | 'settings' | 'export' | 'firstTimeSetup' | 'updateAvailable' | 'recolor' | 'checkpoint' | 'fixer' | 'projectList' | 'modConfig' | 'importMod' | 'renameProject' | 'thumbnail' | 'binSplit' | 'fullResImage' | 'browseWad' | 'fileCompare' | 'addLayer' | 'chromaPort' | 'whatsNew' | 'map-textures' | 'loadscreenBanner' | 'loadManifest' | null;
export type ViewType = 'welcome' | 'preview' | 'editor' | 'project' | 'checkpoints' | 'extract' | 'wad-explorer' | 'file-editor' | 'manifest' | 'archive-editor';

export type FileEditorKind = 'modConfig' | 'binText' | 'raw' | 'luaBin64' | 'troybin';

export interface FileEditorTarget {
    filePath: string;
    kind: FileEditorKind;
    projectPath?: string;
}

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
    /** UUID v4. May be empty for legacy entries. */
    pid?: string;
    name: string;
    champion: string;
    skin: number;
    path: string;
    lastOpened: string;
}

/** Mirrors the Rust enum; drives which type-specific fields are meaningful. */
export type ProjectKind = 'skin' | 'map' | 'loading-screen' | 'tft';

/** Result of `discover_projects` — on-disk walk ∪ projects.json index entries. */
export interface ProjectListing {
    pid: string;
    path: string;
    name: string;
    display_name: string;
    kind: ProjectKind;
    /** Only meaningful for skin projects; empty string for map / loading-screen. */
    champion: string;
    /** Only meaningful for skin projects (0 = base). */
    skin_id: number;
    /** Only set for map projects (e.g. "map11"). */
    map_id?: string | null;
    created_at: string;
    modified_at: string;
    last_seen_at: string;
    /** True if path currently contains a readable mod.config.json. */
    exists: boolean;
    /** True if this row was found by the disk walk (vs. solely the index). */
    on_disk: boolean;
    /** True if the project was rediscovered at a new path this scan. */
    relocated: boolean;
    /** Base64 WebP data URL for the project thumbnail if it exists. */
    thumbnail?: string | null;
}

export interface SavedProject {
    id: string;
    name: string;
    kind: ProjectKind;
    champion: string;
    /** Map id (e.g. "map11") when kind === 'map'. */
    mapId?: string | null;
    path: string;
    lastOpened: string;
    /** Base64 WebP data URL for the project thumbnail if it exists. */
    thumbnail?: string | null;
}

export interface FileTreeNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileTreeNode[];
}

export interface Project {
    /** Stable project id (UUID v4) — populated by the backend on create/open. */
    pid?: string;
    name: string;
    display_name?: string;
    /** Project kind. Older projects without this field default to "skin". */
    kind?: ProjectKind;
    champion: string;
    skin_id: number;
    /** Map id (e.g. "map11") — only set for map projects. */
    map_id?: string | null;
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

export interface ConfirmDialogState {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: (checked: boolean) => void;
    showCheckbox?: boolean;
    checkboxLabel?: string;
    hideCancel?: boolean;
}

export interface ContextMenuState {
    x: number;
    y: number;
    options: ContextMenuOption[];
}

export interface ContextMenuOption {
    label: string;
    icon?: string;
    /** Click handler. Optional when `submenu` is provided — parent items that
     *  only exist to anchor a submenu shouldn't run an action themselves. */
    onClick?: () => void;
    danger?: boolean;
    separator?: boolean;
    disabled?: boolean;
    /** When set, hovering this item opens a side-panel with these options.
     *  Submenus can nest arbitrarily deep. */
    submenu?: ContextMenuOption[];
    /** Optional right-aligned hint text (e.g. "Ctrl+C") rendered after the
     *  label. Doesn't affect behaviour. */
    shortcut?: string;
}

export interface ProjectTab {
    id: string;
    project: Project;
    projectPath: string;
    selectedFile: string | null;
    fileTree: FileTreeNode | null;
    expandedFolders: Set<string>;
    hasAutoExpanded?: boolean;
}

export interface WadChunk {
    hash: string;        // hex string e.g. "0x1a2b3c4d5e6f7a8b"
    path: string | null; // resolved path, null if hash is unknown
    size: number;
    /** Pre-lowercased `path ?? hash` for search. Only the WAD-explorer load path populates it. */
    haystack?: string;
}

export interface ExtractSession {
    id: string;
    wadPath: string;
    wadName: string;              // basename of WAD for display in TabBar
    chunks: WadChunk[];
    selectedHashes: Set<string>;  // hashes checked for bulk extract
    previewHash: string | null;   // hash of the file currently being previewed
    expandedFolders: Set<string>;
    searchQuery: string;
    loading: boolean;
    readOnly?: boolean;
    currentDir: string;
    history: string[];
    historyIndex: number;
    editSessionId?: string;       // backend session ID, if opened
    isDirty?: boolean;            // true if there are unsaved memory edits in the WAD
}

/** A WAD file discovered while scanning a game installation */
export interface GameWadInfo {
    /** Absolute path to the .wad.client file */
    path: string;
    /** Filename e.g. "Aatrox.wad.client" */
    name: string;
    /** Parent directory used as display group e.g. "Champions" */
    category: string;
}

// =============================================================================
// WAD Explorer (VFS) Types
// =============================================================================

/** A WAD file entry in the unified VFS — chunks are loaded lazily on expand */
export interface WadExplorerWad {
    path: string;
    name: string;
    category: string;
    /** 'idle' = not yet fetched | 'loading' = fetch in progress | 'loaded' | 'error' */
    status: 'idle' | 'loading' | 'loaded' | 'error';
    chunks: WadChunk[];
    error?: string;
}

export interface WadExplorerState {
    isOpen: boolean;
    wads: WadExplorerWad[];
    scanStatus: 'idle' | 'scanning' | 'ready' | 'error';
    scanError: string | null;
    /** The currently-previewed chunk */
    selected: { wadPath: string; hash: string } | null;
    /** Set of wad paths that are expanded in the tree */
    expandedWads: Set<string>;
    /** Set of `${wadPath}::${folderPath}` keys for expanded sub-folders */
    expandedFolders: Set<string>;
    searchQuery: string;
    /** Set of `${wadPath}::${hash}` keys for checked files (multi-select for extraction) */
    checkedFiles: Set<string>;
    /** Live tally of checked files per WAD path. */
    checkedCountPerWad: Map<string, number>;
}

export interface AppState {
    status: AppStatus;
    statusMessage: string;

    creatorName: string | null;
    creatorDescription: string | null;
    creatorHome: string | null;
    creatorTip: string | null;

    hashesLoaded: boolean;
    hashCount: number;

    leaguePath: string | null;
    leaguePathPbe: string | null;
    defaultProjectPath: string | null;

    ltkManagerModPath: string | null;
    autoSyncToLauncher: boolean;

    celestialModPath: string | null;
    preferredLauncher: 'ltk' | 'celestial' | null;

    openTabs: ProjectTab[];
    activeTabId: string | null;
    recentProjects: RecentProject[];
    savedProjects: SavedProject[];

    /** path -> status ("M", "N", "D"), compared to last checkpoint. */
    fileChanges: Record<string, string>;

    extractSessions: ExtractSession[];
    activeExtractId: string | null;

    wadExplorer: WadExplorerState;

    currentView: ViewType;
    activeModal: ModalType;
    modalOptions: Record<string, unknown> | null;

    champions: Champion[];
    championsLoaded: boolean;

    toasts: Toast[];

    logs: LogEntry[];
    logPanelExpanded: boolean;

    contextMenu: ContextMenuState | null;

    confirmDialog: ConfirmDialogState | null;

    autoUpdateEnabled: boolean;
    skippedUpdateVersion: string | null;

    verboseLogging: boolean;
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

export interface CheckpointProgress {
    phase: string;
    current: number;
    total: number;
}

export type CheckpointFileContent =
    | { type: 'image'; data: string; width: number; height: number }
    | { type: 'text'; data: string }
    | { type: 'binary'; size: number };

export interface DownloadProgress {
    downloaded: number;
    total: number;
}

// =============================================================================
// Audio / BNK Editor Types
// =============================================================================

export interface AudioEntryInfo {
    id: number;
    size: number;
}

export interface AudioBankInfo {
    format: 'bnk' | 'wpk';
    version: number;
    entry_count: number;
    entries: AudioEntryInfo[];
    has_hirc: boolean;
}

export interface DecodedAudio {
    data: number[];
    format: 'ogg' | 'wav';
    sample_rate: number | null;
}

export interface BinEventString {
    name: string;
    hash: number;
}

export interface EventMapping {
    event_name: string;
    wem_id: number;
    container_id: number;
    music_segment_id: number | null;
    switch_id: number | null;
}

export interface HircData {
    sounds: { self_id: number; file_id: number; is_streamed: boolean }[];
    event_actions: { self_id: number; action_type: number; sound_object_id: number }[];
    events: { self_id: number; action_ids: number[] }[];
    random_containers: { self_id: number; sound_ids: number[] }[];
    switch_containers: { self_id: number; group_id: number; children: number[] }[];
    music_segments: { self_id: number; track_ids: number[] }[];
    music_tracks: { self_id: number; file_ids: number[]; switch_group_id: number; switch_ids: number[] }[];
    music_switches: { self_id: number; children: number[] }[];
    music_playlists: { self_id: number; track_ids: number[] }[];
}

export interface AudioTreeNode {
    id: string;
    name: string;
    audioEntry: AudioEntryInfo | null;
    children: AudioTreeNode[];
}

// =============================================================================
// Fixer (Hematite) Types
// =============================================================================

export interface FixConfig {
    version: string;
    last_updated: string;
    fixes: Record<string, FixRule>;
    wad_fixes?: Record<string, unknown>;
}

export interface FixRule {
    name: string;
    description: string;
    enabled: boolean;
    severity: 'low' | 'medium' | 'high' | 'critical';
    detect: unknown;
    apply: unknown;
}

export interface DetectedIssue {
    fix_id: string;
    fix_name: string;
    severity: string;
    description: string;
}

export interface ScanResult {
    file_path: string;
    detected_issues: DetectedIssue[];
}

export interface ProjectAnalysis {
    project_path: string;
    results: ScanResult[];
    files_scanned: number;
    issues_found: number;
}

export interface AppliedFix {
    fix_id: string;
    description: string;
    changes_count: number;
}

export interface FailedFix {
    fix_id: string;
    error: string;
}

export interface FixResult {
    file_path: string;
    fixes_applied: AppliedFix[];
    fixes_failed: FailedFix[];
    success: boolean;
}

export interface ProjectFixResult {
    project_path: string;
    results: FixResult[];
    total_applied: number;
    total_failed: number;
}

export interface BatchFixResult {
    projects: ProjectFixResult[];
    total_projects: number;
    total_applied: number;
    total_failed: number;
}
