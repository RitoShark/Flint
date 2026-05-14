/**
 * Flint - Tauri Bridge Layer
 * Async wrappers for all Tauri commands with error handling
 */

import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import type { HashStatus, Project, FileTreeNode, Champion, GameWadInfo, AudioBankInfo, DecodedAudio, HircData, BinEventString, EventMapping, RecentProject, SavedProject } from './types';

// =============================================================================
// Error Handling
// =============================================================================

/**
 * Custom error class for Flint API errors
 */
export class FlintError extends Error {
    command: string;
    originalError: unknown;

    constructor(command: string, originalError: unknown) {
        const message = typeof originalError === 'string'
            ? originalError
            : (originalError as Error)?.message || 'Unknown error';
        super(message);
        this.name = 'FlintError';
        this.command = command;
        this.originalError = originalError;
    }

    /**
     * Get a user-friendly error message
     */
    getUserMessage(): string {
        const messages: Record<string, string> = {
            'detect_league': 'Could not detect League of Legends installation.',
            'validate_league': 'The selected path is not a valid League of Legends installation.',
            'download_hashes': 'Failed to download hash files. Please check your internet connection.',
            'get_hash_status': 'Failed to check hash status.',
            'reload_hashes': 'Failed to reload hash files.',
            'force_rebuild_hashes': 'Failed to force rebuild hash database.',
            'discover_champions': 'Failed to discover champions.',
            'get_champion_skins': 'Failed to get skins for this champion.',
            'search_champions': 'Champion search failed.',
            'create_project': 'Failed to create project.',
            'create_loading_screen_project': 'Failed to create loading screen project.',
            'open_project': 'Failed to open project. The project file may be corrupted.',
            'save_project': 'Failed to save project.',
            'list_project_files': 'Failed to list project files.',
            'preconvert_project_bins': 'Failed to pre-convert BIN files.',
            'read_wad': 'Failed to read WAD file. The file may be corrupted.',
            'get_wad_chunks': 'Failed to read WAD contents.',
            'extract_wad': 'Failed to extract files from WAD.',
            'read_wad_chunk_data': 'Failed to read chunk from WAD.',
            'scan_game_wads': 'Failed to scan game WAD directory.',
            'decode_bytes_to_png': 'Failed to decode texture.',
            'convert_bin_to_text': 'Failed to convert BIN to text format.',
            'convert_bin_to_json': 'Failed to convert BIN to JSON format.',
            'convert_text_to_bin': 'Failed to convert text to BIN format.',
            'convert_json_to_bin': 'Failed to convert JSON to BIN format.',
            'read_bin_info': 'Failed to read BIN file information.',
            'parse_bin_file_to_text': 'Failed to parse BIN file.',
            'read_or_convert_bin': 'Failed to load BIN file.',
            'save_ritobin_to_bin': 'Failed to save BIN file.',
            'parse_bin_to_tree': 'Failed to parse BIN structure.',
            'get_bin_paths': 'Failed to extract paths from BIN file.',
            'read_file_bytes': 'Failed to read file.',
            'read_file_info': 'Failed to get file information.',
            'decode_dds_to_png': 'Failed to decode texture file.',
            'decode_texture_to_png': 'Failed to decode texture file.',
            'read_text_file': 'Failed to read text file.',
            'recolor_image': 'Failed to recolor image.',
            'recolor_folder': 'Failed to recolor folder assets.',
            'extract_asset_references': 'Failed to extract asset references.',
            'validate_assets': 'Asset validation failed.',
            'export_fantome': 'Failed to export Fantome package.',
            'export_modpkg': 'Failed to export modpkg package.',
            'read_skn_mesh': 'Failed to read SKN mesh file.',
            'read_scb_mesh': 'Failed to read SCB mesh file.',
            'create_checkpoint': 'Failed to create checkpoint.',
            'list_checkpoints': 'Failed to load checkpoints.',
            'restore_checkpoint': 'Failed to restore checkpoint.',
            'compare_checkpoints': 'Failed to compare checkpoints.',
            'delete_checkpoint': 'Failed to delete checkpoint.',
            'get_ltk_manager_mod_path': 'Failed to find LTK Manager installation.',
            'sync_project_to_launcher': 'Failed to sync project to LTK Manager.',
            'analyze_fantome': 'Failed to analyze Fantome WAD file.',
            'import_fantome_wad': 'Failed to import Fantome mod.',
            'analyze_modpkg': 'Failed to analyze ModPkg file.',
            'import_modpkg': 'Failed to import ModPkg mod.',
            'save_file_bytes': 'Failed to save file.',
            'create_hud_project': 'Failed to create HUD editor project.',
            'parse_hud_ritobin_file': 'Failed to parse HUD ritobin file.',
            'save_hud_ritobin_file': 'Failed to save HUD ritobin file.',
            'get_hud_file_stats': 'Failed to get HUD file statistics.',
            'aggregate_bin_schema': 'Failed to aggregate BIN schema.',
            'aggregate_champion_bin_schema': 'Failed to aggregate champion BIN schema.',
            'find_original_file': 'Failed to look up original file.',
            'create_file_backup': 'Failed to create backup.',
            'read_file_backup': 'Failed to read backup file.',
            'has_file_backup': 'Failed to check backup.',
            'delete_file_backup': 'Failed to delete backup.',
        };
        return messages[this.command] || this.message;
    }

    /**
     * Get a recovery suggestion for this error
     */
    getRecoverySuggestion(): string | null {
        const suggestions: Record<string, string> = {
            'detect_league': 'Go to Settings (Ctrl+,) and set the League path manually.',
            'validate_league': 'Make sure the path points to the League of Legends "Game" folder.',
            'download_hashes': 'Check your internet connection and try again.',
            'discover_champions': 'Ensure League path is set correctly in Settings.',
            'create_project': 'Check that you have write permissions to the selected folder.',
            'create_loading_screen_project': 'Check write permissions and ensure League path is set correctly.',
            'open_project': 'Try opening a different project or create a new one.',
            'save_project': 'Check that the project folder still exists and is writable.',
            'save_ritobin_to_bin': 'Check for syntax errors in the BIN editor.',
            'decode_dds_to_png': 'The texture format may not be supported.',
            'recolor_image': 'Make sure the texture format is supported and the file is not read-only.',
            'recolor_folder': 'Check if the folder contains valid texture files.',
            'read_file_bytes': 'Check that the file exists and is accessible.',
            'export_fantome': 'Ensure all project files are saved.',
            'create_checkpoint': 'Make sure you have enough disk space and the project is not in use by another program.',
            'restore_checkpoint': 'Ensure all project files are closed before restoring.',
        };
        return suggestions[this.command] || null;
    }
}

/**
 * Wrap a Tauri command with consistent error handling.
 *
 * Pass `{ silent: true }` for commands whose failure is *expected* (e.g. an
 * optional file read) — the call still throws so the caller can handle it,
 * but nothing gets logged.
 */
// IPC tracing — flip with `localStorage.flintIpcTrace = '1'` then reload, or
// set window.__FLINT_IPC_TRACE = true at runtime. Default ON in dev.
// Each call logs:
//   [ipc#42 ▶] command_name           — at dispatch
//   [ipc#42 ✓] command_name 12.3ms    — at resolve
//   [ipc#42 ✗] command_name 12.3ms    — at reject
// "queued" gap = time between dispatch and the previous call's resolve
// (helps spot serialized IPC traffic — Tauri default is unbounded
//  parallelism per window, but `tauri::async_runtime::spawn_blocking`
//  pool is limited to ~4–8 threads, so blocking commands queue).
declare global {
    interface Window {
        __FLINT_IPC_TRACE?: boolean;
        __FLINT_IPC_STATS?: () => void;
    }
}

let ipcCounter = 0;
const inFlight = new Map<number, { command: string; start: number }>();
let lastDispatchTime = 0;
let lastSettleTime = 0;
const stats = new Map<string, { count: number; totalMs: number; maxMs: number }>();

function ipcTraceEnabled(): boolean {
    if (typeof window === 'undefined') return false;
    if (window.__FLINT_IPC_TRACE !== undefined) return window.__FLINT_IPC_TRACE;
    try {
        if (localStorage.getItem('flintIpcTrace') === '1') return true;
        if (localStorage.getItem('flintIpcTrace') === '0') return false;
    } catch { /* ignore */ }
    return import.meta.env.DEV;
}

if (typeof window !== 'undefined') {
    window.__FLINT_IPC_STATS = () => {
        const rows = Array.from(stats.entries())
            .map(([cmd, s]) => ({
                command: cmd,
                count: s.count,
                avgMs: +(s.totalMs / s.count).toFixed(2),
                maxMs: +s.maxMs.toFixed(2),
                totalMs: +s.totalMs.toFixed(2),
            }))
            .sort((a, b) => b.totalMs - a.totalMs);
        // eslint-disable-next-line no-console
        console.table(rows);
        // eslint-disable-next-line no-console
        console.log(`[ipc] ${inFlight.size} call(s) currently in flight:`,
            Array.from(inFlight.values()).map(c => `${c.command} (${(performance.now() - c.start).toFixed(0)}ms)`),
        );
    };
}

async function invokeCommand<T>(
    command: string,
    args: Record<string, unknown> = {},
    opts: { silent?: boolean } = {},
): Promise<T> {
    const trace = ipcTraceEnabled();
    const id = ++ipcCounter;
    const start = performance.now();

    if (trace) {
        const sinceLastDispatch = lastDispatchTime ? (start - lastDispatchTime).toFixed(1) : '—';
        const sinceLastSettle = lastSettleTime ? (start - lastSettleTime).toFixed(1) : '—';
        const concurrent = inFlight.size;
        // eslint-disable-next-line no-console
        console.log(
            `[ipc#${id} ▶] ${command}  (gap-since-dispatch=${sinceLastDispatch}ms, gap-since-settle=${sinceLastSettle}ms, in-flight=${concurrent})`,
        );
        inFlight.set(id, { command, start });
        lastDispatchTime = start;
    }

    try {
        const result = await invoke<T>(command, args);
        if (trace) {
            const ms = performance.now() - start;
            inFlight.delete(id);
            lastSettleTime = performance.now();
            const s = stats.get(command) ?? { count: 0, totalMs: 0, maxMs: 0 };
            s.count++; s.totalMs += ms; if (ms > s.maxMs) s.maxMs = ms;
            stats.set(command, s);
            // eslint-disable-next-line no-console
            console.log(`[ipc#${id} ✓] ${command} ${ms.toFixed(1)}ms`);
        }
        return result;
    } catch (error) {
        if (trace) {
            const ms = performance.now() - start;
            inFlight.delete(id);
            lastSettleTime = performance.now();
            // eslint-disable-next-line no-console
            console.warn(`[ipc#${id} ✗] ${command} ${ms.toFixed(1)}ms — ${String(error).slice(0, 200)}`);
        }
        if (!opts.silent) {
            console.error(`[Flint] Command "${command}" failed:`, error);
        }
        throw new FlintError(command, error);
    }
}

/**
 * Variant of `invokeCommand` for the raw-bytes IPC path.
 *
 * Pass an ArrayBuffer / Uint8Array as `body` to send a raw request body
 * (Tauri's `tauri::ipc::Request<'_>` on the Rust side) instead of the default
 * JSON encoding. Scalar args ride along in `headers` — `String` values only,
 * since this is HTTP-style transport. Use `expectRawResponse: true` when the
 * command returns `tauri::ipc::Response::new(bytes)` and you want the
 * ArrayBuffer back without going through JSON.
 *
 * Why this exists: `Array.from(uint8)` on the way out + `[1,2,3,…]` JSON on
 * the way back was the dominant cost for multi-MB payloads (textures, audio
 * banks, WAD chunks). The raw path is a `memcpy` on each side.
 */
async function invokeRaw<T>(
    command: string,
    body: ArrayBuffer | ArrayBufferView | Uint8Array | undefined,
    headers: Record<string, string> = {},
    opts: { silent?: boolean } = {},
): Promise<T> {
    const trace = ipcTraceEnabled();
    const id = ++ipcCounter;
    const start = performance.now();

    if (trace) {
        const sinceLastDispatch = lastDispatchTime ? (start - lastDispatchTime).toFixed(1) : '—';
        const sinceLastSettle = lastSettleTime ? (start - lastSettleTime).toFixed(1) : '—';
        const concurrent = inFlight.size;
        // eslint-disable-next-line no-console
        console.log(
            `[ipc#${id} ▶] ${command} (raw)  (gap-since-dispatch=${sinceLastDispatch}ms, gap-since-settle=${sinceLastSettle}ms, in-flight=${concurrent})`,
        );
        inFlight.set(id, { command, start });
        lastDispatchTime = start;
    }

    const args: InvokeArgs = (body ?? new Uint8Array()) as InvokeArgs;
    const options: InvokeOptions = { headers };

    try {
        const result = await invoke<T>(command, args, options);
        if (trace) {
            const ms = performance.now() - start;
            inFlight.delete(id);
            lastSettleTime = performance.now();
            const s = stats.get(command) ?? { count: 0, totalMs: 0, maxMs: 0 };
            s.count++; s.totalMs += ms; if (ms > s.maxMs) s.maxMs = ms;
            stats.set(command, s);
            // eslint-disable-next-line no-console
            console.log(`[ipc#${id} ✓] ${command} ${ms.toFixed(1)}ms`);
        }
        return result;
    } catch (error) {
        if (trace) {
            const ms = performance.now() - start;
            inFlight.delete(id);
            lastSettleTime = performance.now();
            // eslint-disable-next-line no-console
            console.warn(`[ipc#${id} ✗] ${command} ${ms.toFixed(1)}ms — ${String(error).slice(0, 200)}`);
        }
        if (!opts.silent) {
            console.error(`[Flint] Command "${command}" failed:`, error);
        }
        throw new FlintError(command, error);
    }
}

// =============================================================================
// Logging Commands
// =============================================================================

export async function setLogLevel(verbose: boolean): Promise<void> {
    return invokeCommand('set_log_level', { verbose });
}

/**
 * Emit test logs at all levels to verify logging is working
 */
export async function testLogging(): Promise<void> {
    return invokeCommand('test_logging', {});
}

// =============================================================================
// Hash Management Commands
// =============================================================================

export async function downloadHashes(): Promise<{ downloaded: number; total: number }> {
    return invokeCommand('download_hashes');
}

export async function getHashStatus(): Promise<HashStatus> {
    return invokeCommand('get_hash_status');
}

export async function reloadHashes(): Promise<{ count: number }> {
    return invokeCommand('reload_hashes');
}

export async function forceRebuildHashes(): Promise<void> {
    return invokeCommand('force_rebuild_hashes');
}

// =============================================================================
// League Detection Commands
// =============================================================================

export async function detectLeague(): Promise<{ path: string; source: string }> {
    return invokeCommand('detect_league');
}

interface LeagueInstallation {
    path: string;
    game_path: string;
    auto_detected: boolean;
}

export async function validateLeague(path: string): Promise<{ valid: boolean; path: string | null }> {
    try {
        const result = await invokeCommand<LeagueInstallation>('validate_league', { path });
        return { valid: true, path: result.path };
    } catch {
        return { valid: false, path: null };
    }
}

// =============================================================================
// Champion Discovery Commands
// =============================================================================

export async function discoverChampions(leaguePath: string): Promise<Champion[]> {
    return invokeCommand('discover_champions', { leaguePath });
}

export async function getChampionSkins(
    leaguePath: string,
    championId: string
): Promise<Array<{ id: number; name: string }>> {
    return invokeCommand('get_champion_skins', { leaguePath, championId });
}

export async function searchChampions(
    leaguePath: string,
    query: string
): Promise<Array<{ name: string; id: string }>> {
    return invokeCommand('search_champions', { leaguePath, query });
}

// =============================================================================
// Project Management Commands
// =============================================================================

interface CreateProjectParams {
    name: string;
    champion: string;
    skin: number;
    projectPath: string;
    leaguePath: string;
    creatorName?: string;
    useJade?: boolean;
    isPbe?: boolean;
}

export async function createProject(params: CreateProjectParams): Promise<Project> {
    return invokeCommand('create_project', {
        name: params.name,
        champion: params.champion,
        skinId: params.skin,
        outputPath: params.projectPath,
        leaguePath: params.leaguePath,
        creatorName: params.creatorName,
        useJade: params.useJade,
        isPbe: params.isPbe,
    });
}

interface CreateLoadingScreenParams {
    name: string;
    projectPath: string;
    leaguePath: string;
    creatorName: string;
    spritesheetPngData: number[];
    frameWidth: number;
    frameHeight: number;
    sheetWidth: number;
    sheetHeight: number;
    fps: number;
    totalFrames: number;
    cols: number;
    rows: number;
}

export async function createLoadingScreenProject(params: CreateLoadingScreenParams): Promise<Project> {
    return invokeCommand('create_loading_screen_project', {
        name: params.name,
        projectPath: params.projectPath,
        leaguePath: params.leaguePath,
        creatorName: params.creatorName,
        spritesheetPngData: params.spritesheetPngData,
        frameWidth: params.frameWidth,
        frameHeight: params.frameHeight,
        sheetWidth: params.sheetWidth,
        sheetHeight: params.sheetHeight,
        fps: params.fps,
        totalFrames: params.totalFrames,
        cols: params.cols,
        rows: params.rows,
    });
}

export interface CreateHudProjectParams {
    projectName: string;
    creatorName: string;
    description: string;
    projectsDir: string;
}

export async function createHudProject(params: CreateHudProjectParams): Promise<string> {
    return invokeCommand('create_hud_project', {
        projectName: params.projectName,
        creatorName: params.creatorName,
        description: params.description,
        projectsDir: params.projectsDir,
    });
}

// =============================================================================
// Map Project Commands
// =============================================================================

export interface MapEntry {
    id: string;
    displayName: string;
    hasLevels: boolean;
}

export interface MapVariant {
    name: string;
    mapgeo: string;
    materials: string;
}

export async function listAvailableMaps(leaguePath: string): Promise<MapEntry[]> {
    return invokeCommand('list_available_maps', { leaguePath });
}

export async function listMapVariants(leaguePath: string, mapId: string): Promise<MapVariant[]> {
    return invokeCommand('list_map_variants', { leaguePath, mapId });
}

export interface CreateMapProjectParams {
    name: string;
    mapId: string;
    includeLevels: boolean;
    projectPath: string;
    leaguePath: string;
    creatorName?: string;
    /** 'variant' (default) extracts only the chosen variant + its referenced
     *  kit-piece assets + matching LEVELS lightmaps. 'full' dumps the whole
     *  WAD (legacy behaviour). */
    extractMode?: 'variant' | 'full';
    /** Required when extractMode is 'variant'. Variant base name from
     *  `listMapVariants`. */
    variantName?: string;
}

export async function createMapProject(params: CreateMapProjectParams): Promise<Project> {
    return invokeCommand('create_map_project', {
        name: params.name,
        mapId: params.mapId,
        includeLevels: params.includeLevels,
        outputPath: params.projectPath,
        leaguePath: params.leaguePath,
        creatorName: params.creatorName,
        extractMode: params.extractMode ?? 'variant',
        variantName: params.variantName,
    });
}

export async function openProject(projectPath: string): Promise<Project> {
    return invokeCommand('open_project', { path: projectPath });
}

export async function saveProject(project: Project): Promise<void> {
    return invokeCommand('save_project', { project });
}

export async function deleteProject(projectPath: string): Promise<void> {
    return invokeCommand('delete_project', { projectPath });
}

/** Walk the projects root one level deep and return every Flint project
 *  found there, merged with the on-disk `projects.json` index. */
export async function discoverProjects(projectsRoot: string): Promise<import('./types').ProjectListing[]> {
    return invokeCommand('discover_projects', { projectsRoot });
}

/** Drop a project from `projects.json` (does not touch the project folder). */
export async function forgetProject(projectsRoot: string, pid: string): Promise<boolean> {
    return invokeCommand('forget_project', { projectsRoot, pid });
}

// Backend file tree entry format
interface BackendFileEntry {
    path: string;
    size?: number;
    children?: Record<string, BackendFileEntry>;
}

/**
 * Transform backend file tree format to frontend FileTreeNode format
 * Backend: { "name": { path, children: {...} } }
 * Frontend: { name, path, isDirectory, children: [...] }
 */
function transformFileTree(
    backendTree: Record<string, BackendFileEntry>,
    rootName = 'Project'
): FileTreeNode {
    const transformNode = (name: string, entry: BackendFileEntry): FileTreeNode => {
        const isDirectory = entry.children !== undefined;
        const node: FileTreeNode = {
            name,
            path: entry.path,
            isDirectory,
        };

        if (isDirectory && entry.children) {
            node.children = Object.entries(entry.children)
                .map(([childName, childEntry]) => transformNode(childName, childEntry))
                .sort((a, b) => {
                    // Directories first, then alphabetically
                    if (a.isDirectory !== b.isDirectory) {
                        return a.isDirectory ? -1 : 1;
                    }
                    return a.name.localeCompare(b.name);
                });
        }

        return node;
    };

    // Create root node with all entries as children
    const children = Object.entries(backendTree)
        .map(([name, entry]) => transformNode(name, entry))
        .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
                return a.isDirectory ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

    return {
        name: rootName,
        path: '.',
        isDirectory: true,
        children,
    };
}

export async function listProjectFiles(projectPath: string): Promise<FileTreeNode> {
    const rawTree = await invokeCommand<Record<string, BackendFileEntry>>('list_project_files', { projectPath });
    return transformFileTree(rawTree, 'Project');
}

/**
 * Lightweight existence + manifest check for a project directory. Use this
 * when you only need to know "is this project still valid?" — far cheaper than
 * `listProjectFiles`, which recursively walks the entire content/ tree.
 */
export async function projectPathValid(projectPath: string): Promise<boolean> {
    return invokeCommand('project_path_valid', { projectPath });
}

export async function preconvertProjectBins(projectPath: string): Promise<number> {
    return invokeCommand('preconvert_project_bins', { projectPath });
}

export interface CreateLayerResult {
    layer_name: string;
    layer_path: string;
    files_copied: number;
    bytes_copied: number;
}

export async function createProjectLayer(args: {
    projectPath: string;
    layerName: string;
    sourceLayer: string;
    categories: string[];
    description?: string;
    priority?: number;
}): Promise<CreateLayerResult> {
    return invokeCommand('create_project_layer', args);
}

export async function listProjectLayers(projectPath: string): Promise<string[]> {
    return invokeCommand('list_project_layers', { projectPath });
}

// =============================================================================
// LTK Manager Integration Commands
// =============================================================================

/**
 * Get the LTK Manager mod storage path
 * Returns null if LTK Manager is not installed or settings cannot be found
 */
export async function getLtkManagerModPath(): Promise<string | null> {
    return invokeCommand('get_ltk_manager_mod_path', {});
}

/**
 * Get the Celestial launcher's mod storage path. Returns null if Celestial
 * isn't installed.
 */
export async function getCelestialModPath(): Promise<string | null> {
    return invokeCommand('get_celestial_mod_path', {});
}

/**
 * Sync a Flint project to LTK Manager
 * Packages the project as .modpkg and installs it to the launcher
 *
 * @param projectPath - Path to the Flint project
 * @param ltkStoragePath - LTK Manager mod storage path (from getLtkManagerModPath)
 * @returns The installed mod ID in LTK Manager
 */
export async function syncProjectToLauncher(projectPath: string, ltkStoragePath: string): Promise<string> {
    return invokeCommand('sync_project_to_launcher', { projectPath, ltkStoragePath });
}

/**
 * Start watching a project directory for changes (auto-sync)
 *
 * @param projectPath - Path to the Flint project
 * @param ltkStoragePath - LTK Manager mod storage path
 */
export async function startProjectWatcher(projectPath: string, ltkStoragePath: string): Promise<void> {
    return invokeCommand('start_project_watcher', { projectPath, ltkStoragePath });
}

/**
 * Stop the active project watcher
 */
export async function stopProjectWatcher(): Promise<void> {
    return invokeCommand('stop_project_watcher', {});
}

/**
 * Start preview file watcher for hot reload
 * @param projectPath - Path to the Flint project
 */
export async function startPreviewWatcher(projectPath: string): Promise<void> {
    return invokeCommand('start_preview_watcher', { projectPath });
}

/**
 * Stop the active preview watcher
 */
export async function stopPreviewWatcher(): Promise<void> {
    return invokeCommand('stop_preview_watcher', {});
}

// =============================================================================
// WAD Commands
// =============================================================================

export async function readWad(wadPath: string): Promise<{ version: string; chunkCount: number }> {
    return invokeCommand('read_wad', { wadPath });
}

export async function getWadChunks(
    wadPath: string,
): Promise<Array<{ hash: string; path: string | null; size: number }>> {
    // Route through the binary-wire `load_all_wad_chunks` so a typical
    // 1500-chunk WAD doesn't pay the JSON encode/decode cost. Same shape as
    // before — only the transport changes.
    const batches = await loadAllWadChunks([wadPath]);
    const batch = batches[0];
    if (batch?.error) {
        throw new FlintError('get_wad_chunks', batch.error);
    }
    return batch?.chunks ?? [];
}

export interface WadChunkBatch {
    path: string;
    chunks: Array<{ hash: string; path: string | null; size: number; haystack: string }>;
    error: string | null;
}

/**
 * Wire format for `load_all_wad_chunks` is raw bytes via `tauri::ipc::Response`,
 * NOT JSON. JSON encode + transit + decode of an 820K-row payload was running
 * at ~7 seconds in dev — the bulk of which was serde/JSON.parse CPU on both
 * sides. The binary path goes:
 *
 *   Rust packs structs → ArrayBuffer → `new DataView()` walk in JS
 *
 * which is essentially free at this scale (~50 MB of memcpy + a tight
 * decoder loop, no JSON tokenizer involved).
 *
 * Wire layout (little-endian):
 *
 *   [u32 wad_count]
 *   per WAD:
 *     [u32 path_len] [path_bytes utf-8]
 *     [u32 error_len] [error_bytes utf-8]    // 0 when no error
 *     [u32 chunk_count]
 *     [chunk_count × u64 path_hash]          // raw — JS hex-formats on demand
 *     [chunk_count × u32 size]
 *     [chunk_count × u16 resolved_path_len]  // 0xFFFF = null/unresolved
 *     [packed resolved-path utf-8 bytes ...]
 */
function decodeWadChunkPayload(bytes: Uint8Array): WadChunkBatch[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const utf8 = new TextDecoder('utf-8');
    let off = 0;

    const wadCount = view.getUint32(off, true); off += 4;
    const out: WadChunkBatch[] = new Array(wadCount);

    // Hex lookup table — building 820K hashes via toString(16) + padStart was
    // measurable in profiles. A 256-entry "00".."ff" lookup is faster.
    const HEX = new Array<string>(256);
    for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, '0');

    for (let w = 0; w < wadCount; w++) {
        const pathLen = view.getUint32(off, true); off += 4;
        const path = utf8.decode(bytes.subarray(off, off + pathLen)); off += pathLen;

        const errLen = view.getUint32(off, true); off += 4;
        if (errLen > 0) {
            const error = utf8.decode(bytes.subarray(off, off + errLen)); off += errLen;
            // No chunk_count when errored — the encoder writes 0 here regardless.
            const chunkCount = view.getUint32(off, true); off += 4;
            // Skip any (defensive — should always be 0 on the error path)
            off += chunkCount * (8 + 4 + 2);
            out[w] = { path, chunks: [], error };
            continue;
        }

        const chunkCount = view.getUint32(off, true); off += 4;
        const hashesOff = off;          off += chunkCount * 8;
        const sizesOff  = off;          off += chunkCount * 4;
        const lensOff   = off;          off += chunkCount * 2;
        // After the lens table comes the packed string bytes — we'll walk
        // both in lockstep below.
        let stringsOff = off;

        const chunks = new Array(chunkCount);
        for (let i = 0; i < chunkCount; i++) {
            // Hash → 16-char lowercase hex via 8 byte-lookups (big-endian
            // textual representation, but bytes themselves are LE in memory).
            const hbase = hashesOff + i * 8;
            const hash =
                HEX[bytes[hbase + 7]] +
                HEX[bytes[hbase + 6]] +
                HEX[bytes[hbase + 5]] +
                HEX[bytes[hbase + 4]] +
                HEX[bytes[hbase + 3]] +
                HEX[bytes[hbase + 2]] +
                HEX[bytes[hbase + 1]] +
                HEX[bytes[hbase + 0]];

            const size = view.getUint32(sizesOff + i * 4, true);
            const plen = view.getUint16(lensOff + i * 2, true);

            let path: string | null;
            let haystack: string;
            if (plen === 0xFFFF) {
                path = null;
                haystack = hash;
            } else {
                path = utf8.decode(bytes.subarray(stringsOff, stringsOff + plen));
                stringsOff += plen;
                // Pre-lowercase once. The WAD-explorer search runs `includes`
                // / `startsWith` against this on every debounced keystroke,
                // and re-lowercasing 36M chunks per query was the dominant
                // cost for "all-WADs-loaded" workflows.
                haystack = path.toLowerCase();
            }
            chunks[i] = { hash, path, size, haystack };
        }
        off = stringsOff;
        out[w] = { path, chunks, error: null };
    }
    return out;
}

export async function loadAllWadChunks(paths: string[]): Promise<WadChunkBatch[]> {
    // Tauri returns ArrayBuffer for byte responses (commands that return
    // `tauri::ipc::Response::new(bytes)`). Skip the JSON path entirely.
    const buf = await invokeCommand<ArrayBuffer>('load_all_wad_chunks', { paths });
    return decodeWadChunkPayload(new Uint8Array(buf));
}

export interface ExtractHashesResult {
    /** Files (BIN + SKN) actually scanned. */
    scanned: number;
    /** New (path → xxhash64) pairs added to hashes.extracted.txt */
    game_hashes_added: number;
    /** New (name → fnv1a32) pairs added to hashes.binhashes.extracted.txt */
    bin_hashes_added: number;
    /** Absolute paths of files written / merged. */
    output_files: string[];
}

/**
 * Scan a WAD's BIN/SKN chunks for path hashes and merge results into the user
 * hash directory. See `commands/extract_hashes.rs` for the scanner spec.
 */
export async function extractHashesFromWad(wadPath: string): Promise<ExtractHashesResult> {
    return invokeCommand('extract_hashes_from_wad', { wadPath });
}

export async function extractWad(
    wadPath: string,
    outputDir: string,
    chunkHashes: string[] | null = null
): Promise<{ extracted: number }> {
    return invokeCommand('extract_wad', { wadPath, outputDir, chunkHashes });
}

/**
 * Read a single WAD chunk into memory without writing to disk.
 * Returns the decompressed raw bytes of the chunk.
 */
export async function readWadChunkData(wadPath: string, hash: string): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('read_wad_chunk_data', { wadPath, hash });
    return new Uint8Array(buf);
}

/**
 * Scan a League Game/ directory for all .wad.client files, grouped by category.
 */
export async function scanGameWads(gamePath: string): Promise<GameWadInfo[]> {
    return invokeCommand('scan_game_wads', { gamePath });
}

/**
 * Invalidate a WAD entry from the metadata cache so the next read re-parses it.
 */
export async function invalidateWadCache(wadPath: string): Promise<void> {
    return invokeCommand('invalidate_wad_cache', { path: wadPath });
}

/**
 * Read and convert a luabin (Lua bytecode) chunk from a WAD to Lua source text.
 */
export async function readWadLuabin(wadPath: string, hash: string): Promise<string> {
    return invokeCommand('read_wad_luabin', { wadPath, hash });
}

/**
 * Read and convert a troybin chunk from a WAD to INI-like text.
 */
export async function readWadTroybin(wadPath: string, hash: string): Promise<string> {
    return invokeCommand('read_wad_troybin', { wadPath, hash });
}

/**
 * Convert luabin (Lua bytecode) data to Lua source text.
 */
export async function convertLuabinToText(data: Uint8Array): Promise<string> {
    return invokeCommand('convert_luabin_to_text', { data: Array.from(data) });
}

/**
 * Convert troybin data to INI-like text.
 */
export async function convertTroybinToText(data: Uint8Array): Promise<string> {
    return invokeCommand('convert_troybin_to_text', { data: Array.from(data) });
}

/**
 * Extract an SKN chunk + companion files from a WAD to a temp directory for 3D preview.
 */
export async function extractWadModelPreview(
    wadPath: string,
    sknHash: string
): Promise<{ skn_path: string; temp_dir: string }> {
    return invokeCommand('extract_wad_model_preview', { wadPath, sknHash });
}

/**
 * Clean up a temporary WAD model preview directory.
 */
export async function cleanupWadModelPreview(tempDir: string): Promise<void> {
    return invokeCommand('cleanup_wad_model_preview', { tempDir });
}

// =============================================================================
// BIN Commands
// =============================================================================

export async function convertBinToText(binData: Uint8Array): Promise<string> {
    return invokeRaw('convert_bin_bytes_to_text', binData);
}

export async function convertBinToJson(binData: Uint8Array): Promise<unknown> {
    return invokeRaw('convert_bin_bytes_to_json', binData);
}

export async function convertTextToBin(textContent: string): Promise<Uint8Array> {
    const result = await invokeCommand<number[]>('convert_text_to_bin', { textContent });
    return new Uint8Array(result);
}

export async function convertJsonToBin(jsonContent: unknown): Promise<Uint8Array> {
    const result = await invokeCommand<number[]>('convert_json_to_bin', { jsonContent });
    return new Uint8Array(result);
}

export async function readBinInfo(binData: Uint8Array): Promise<{ version: string; entryCount: number }> {
    return invokeCommand('read_bin_info', { binData: Array.from(binData) });
}

// Multi-MB ritobin text comes back as raw UTF-8 bytes — `TextDecoder` is
// faster than `JSON.parse('"..."')` for huge strings and avoids the
// backslash-escape round-trip on the Rust side.
const utf8Decoder = new TextDecoder('utf-8');

export async function parseBinFileToText(path: string): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('parse_bin_file_to_text', { path });
    return utf8Decoder.decode(buf);
}

export async function readOrConvertBin(binPath: string, useJade?: boolean): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('read_or_convert_bin', { binPath, useJade });
    return utf8Decoder.decode(buf);
}

export async function saveRitobinToBin(binPath: string, content: string, useJade?: boolean): Promise<void> {
    return invokeCommand('save_ritobin_to_bin', { binPath, content, useJade });
}

export async function parseBinToTree(binPath: string): Promise<unknown[]> {
    return invokeCommand('parse_bin_to_tree', { binPath });
}

export async function getBinPaths(binPath: string): Promise<unknown[]> {
    return invokeCommand('get_bin_paths', { binPath });
}

// =============================================================================
// File Commands (Preview System)
// =============================================================================

export async function readFileBytes(path: string, opts: { silent?: boolean } = {}): Promise<Uint8Array> {
    // Backend returns `tauri::ipc::Response::new(bytes)` — Tauri delivers it as
    // an ArrayBuffer (no JSON encode/decode of the byte array).
    const buf = await invokeCommand<ArrayBuffer>('read_file_bytes', { path }, opts);
    return new Uint8Array(buf);
}

interface FileInfo {
    path: string;
    size: number;
    fileType: string;
    extension: string;
    dimensions: [number, number] | null;
}

export async function readFileInfo(path: string): Promise<FileInfo> {
    return invokeCommand('read_file_info', { path });
}

interface DecodedTexture {
    data: string;
    width: number;
    height: number;
    format: string;
}

/**
 * Decode DDS or TEX texture file to PNG
 * Despite the name, this handles both DDS and TEX formats
 */
export async function decodeDdsToPng(path: string): Promise<DecodedTexture> {
    return invokeCommand('decode_dds_to_png', { path });
}

/**
 * Decode raw DDS/TEX bytes (already in memory) to a base64-encoded PNG.
 * Used by the WAD browser for in-memory preview — no disk file needed.
 */
export async function decodeBytesToPng(data: Uint8Array): Promise<DecodedTexture> {
    // Send the texture as a raw request body — `Array.from(uint8)` was costing
    // ~3× the wire size and a JSON encode/decode on multi-MB textures.
    return invokeRaw('decode_bytes_to_png', data);
}

/**
 * Get bundled floor texture as PNG bytes (MindCorpViewer floor.dds pre-converted)
 */
export async function getBundledFloorPng(): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('get_bundled_floor_png', {});
    return new Uint8Array(buf);
}

export async function readTextFile(path: string): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('read_text_file', { path });
    return utf8Decoder.decode(buf);
}

export async function writeTextFile(path: string, content: string): Promise<void> {
    return invokeCommand('write_text_file', { path, content });
}

export async function saveFileBytes(path: string, data: Uint8Array | number[]): Promise<void> {
    // Path travels in a header, bytes go in the request body — no JSON encoding
    // for what's typically a thumbnail or other multi-KB binary.
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return invokeRaw('save_file_bytes', bytes, { path });
}

export async function recolorImage(
    path: string,
    hue: number,
    saturation: number,
    brightness: number
): Promise<void> {
    return invokeCommand('recolor_image', { path, hue, saturation, brightness });
}

export async function recolorFolder(
    path: string,
    hue: number,
    saturation: number,
    brightness: number,
    skipDistortion: boolean = true
): Promise<{ processed: number; failed: number }> {
    return invokeCommand('recolor_folder', { path, hue, saturation, brightness, skipDistortion });
}

export async function colorizeImage(
    path: string,
    targetHue: number,
    preserveSaturation: boolean
): Promise<void> {
    return invokeCommand('colorize_image', { path, targetHue, preserveSaturation });
}

export async function colorizeFolder(
    path: string,
    targetHue: number,
    preserveSaturation: boolean,
    skipDistortion: boolean = true
): Promise<{ processed: number; failed: number }> {
    return invokeCommand('colorize_folder', { path, targetHue, preserveSaturation, skipDistortion });
}

// =============================================================================
// Validation Commands
// =============================================================================

export async function extractAssetReferences(binData: Uint8Array): Promise<string[]> {
    return invokeCommand('extract_asset_references', { binData: Array.from(binData) });
}

export async function validateAssets(
    assetPaths: string[],
    wadPath: string
): Promise<{ valid: string[]; missing: string[] }> {
    return invokeCommand('validate_assets', { assetPaths, wadPath });
}

// =============================================================================
// Export Commands
// =============================================================================

interface ExportMetadata {
    name: string;
    author: string;
    version: string;
    description: string;
}

interface ExportParams {
    projectPath: string;
    outputPath: string;
    format: 'fantome' | 'modpkg';
    champion: string;
    metadata: ExportMetadata;
}

export async function exportProject(params: ExportParams): Promise<{ path: string }> {
    if (params.format === 'fantome') {
        return invokeCommand('export_fantome', {
            projectPath: params.projectPath,
            outputPath: params.outputPath,
            champion: params.champion,
            metadata: params.metadata,
            autoRepath: true,
        });
    }
    // modpkg format
    return invokeCommand('export_modpkg', {
        projectPath: params.projectPath,
        outputPath: params.outputPath,
    });
}

// =============================================================================
// Mesh Commands (3D Preview)
// =============================================================================

interface MaterialRange {
    name: string;
    start_index: number;
    index_count: number;
    start_vertex: number;
    vertex_count: number;
}

type MaterialDataInfo = {
    texture: string;
    uv_scale?: [number, number];
    uv_offset?: [number, number];
    flipbook_size?: [number, number];
    flipbook_frame?: number;
};

/**
 * Mesh data uses typed arrays for vertex buffers — these come straight off
 * the IPC `ArrayBuffer` and are handed directly to `THREE.BufferAttribute`,
 * so the renderer skips the per-vertex JSON round-trip entirely.
 */
export interface SknMeshData {
    kind: 'skn';
    materials: MaterialRange[];
    bounding_box: [[number, number, number], [number, number, number]];
    textures?: Record<string, string>;
    material_data?: Record<string, MaterialDataInfo>;
    texture_warning?: string;
    /** Vertex count derived from `positions.length / 3`. */
    vertex_count: number;
    /** Index count derived from `indices.length`. */
    index_count: number;
    positions: Float32Array; // vertex_count × 3
    normals: Float32Array;   // vertex_count × 3
    uvs: Float32Array;       // vertex_count × 2
    indices: Uint16Array;
    /** Present when the mesh is rigged (always 4 weights per vertex). */
    bone_weights?: Float32Array; // vertex_count × 4
    bone_indices?: Uint8Array;   // vertex_count × 4
}

export interface ScbMeshData {
    kind: 'scb';
    name: string;
    materials: string[];
    bounding_box: [[number, number, number], [number, number, number]];
    material_ranges: Record<string, [number, number]>;
    material_data?: Record<string, MaterialDataInfo>;
    texture_warning?: string;
    vertex_count: number;
    index_count: number;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

/**
 * Wire format for `read_skn_mesh` / `read_scb_mesh` (see `mesh::wire` on the
 * Rust side). The big vertex/index buffers travel as raw bytes; the small
 * structural metadata sits in a length-prefixed JSON header up front.
 *
 * Shape:
 * ```text
 * [u32 meta_len] [meta_json utf-8] [pad to 4-byte boundary]
 * [vertex_count × 3 × f32] positions
 * [vertex_count × 3 × f32] normals
 * [vertex_count × 2 × f32] uvs
 * [index_count × idx_bytes] indices  (idx_bytes = 2 for SKN, 4 for SCB)
 * (SKN only when has_bones)
 *   [vertex_count × 4 × f32] bone_weights
 *   [vertex_count × 4 × u8]  bone_indices
 * ```
 *
 * We `slice()` each typed array into a fresh buffer rather than wrapping the
 * source `ArrayBuffer` in place — copying ~MB of bytes is microseconds, and
 * Three.js can keep its `BufferAttribute`s alive without us tracking the
 * lifetime of the original IPC buffer.
 */
function decodeMeshPayload(buf: ArrayBuffer): SknMeshData | ScbMeshData {
    const view = new DataView(buf);
    const metaLen = view.getUint32(0, true);
    const metaBytes = new Uint8Array(buf, 4, metaLen);
    const meta = JSON.parse(new TextDecoder('utf-8').decode(metaBytes));

    // Step past the JSON header to the first 4-byte-aligned offset.
    let off = 4 + metaLen;
    if (off % 4 !== 0) off += 4 - (off % 4);

    const vertexCount: number = meta.vertex_count;
    const indexCount: number = meta.index_count;
    const indexBits: number = meta.index_bits;

    const posLen = vertexCount * 3;
    const positions = new Float32Array(buf.slice(off, off + posLen * 4));
    off += posLen * 4;

    const normals = new Float32Array(buf.slice(off, off + posLen * 4));
    off += posLen * 4;

    const uvLen = vertexCount * 2;
    const uvs = new Float32Array(buf.slice(off, off + uvLen * 4));
    off += uvLen * 4;

    let indices: Uint16Array | Uint32Array;
    if (indexBits === 16) {
        indices = new Uint16Array(buf.slice(off, off + indexCount * 2));
        off += indexCount * 2;
    } else {
        indices = new Uint32Array(buf.slice(off, off + indexCount * 4));
        off += indexCount * 4;
    }

    if (meta.kind === 'skn') {
        const skn: SknMeshData = {
            kind: 'skn',
            materials: meta.materials,
            bounding_box: meta.bounding_box,
            textures: meta.textures,
            material_data: meta.material_data,
            texture_warning: meta.texture_warning,
            vertex_count: vertexCount,
            index_count: indexCount,
            positions,
            normals,
            uvs,
            indices: indices as Uint16Array,
        };
        if (meta.has_bones) {
            const bwLen = vertexCount * 4;
            skn.bone_weights = new Float32Array(buf.slice(off, off + bwLen * 4));
            off += bwLen * 4;
            skn.bone_indices = new Uint8Array(buf.slice(off, off + bwLen));
        }
        return skn;
    }

    const scb: ScbMeshData = {
        kind: 'scb',
        name: meta.name,
        materials: meta.materials,
        bounding_box: meta.bounding_box,
        material_ranges: meta.material_ranges,
        material_data: meta.material_data,
        texture_warning: meta.texture_warning,
        vertex_count: vertexCount,
        index_count: indexCount,
        positions,
        normals,
        uvs,
        indices: indices as Uint32Array,
    };
    return scb;
}

/**
 * Read and parse an SKN (skinned mesh) file for 3D preview.
 */
export async function readSknMesh(path: string): Promise<SknMeshData> {
    const buf = await invokeCommand<ArrayBuffer>('read_skn_mesh', { path });
    const mesh = decodeMeshPayload(buf);
    if (mesh.kind !== 'skn') throw new Error('Expected SKN payload, got SCB');
    return mesh;
}

/**
 * Read and parse an SCB/SCO (static mesh) file for 3D preview.
 */
export async function readScbMesh(path: string): Promise<ScbMeshData> {
    const buf = await invokeCommand<ArrayBuffer>('read_scb_mesh', { path });
    const mesh = decodeMeshPayload(buf);
    if (mesh.kind !== 'scb') throw new Error('Expected SCB payload, got SKN');
    return mesh;
}

// =============================================================================
// Skeleton Commands (SKL)
// =============================================================================

interface BoneData {
    name: string;
    id: number;
    parent_id: number;
    local_translation: [number, number, number];
    local_rotation: [number, number, number, number];  // quaternion [x, y, z, w]
    local_scale: [number, number, number];
    world_position: [number, number, number];
    inverse_bind_matrix: [[number, number, number, number], [number, number, number, number], [number, number, number, number], [number, number, number, number]];  // 4x4 column-major matrix
}

interface SklData {
    name: string;
    asset_name: string;
    bones: BoneData[];
    influences: number[];  // Maps vertex bone indices to actual bone IDs
}

/**
 * Read and parse an SKL (skeleton) file for 3D preview
 */
export async function readSklSkeleton(path: string): Promise<SklData> {
    return invokeCommand('read_skl_skeleton', { path });
}

// =============================================================================
// Animation Commands
// =============================================================================

interface AnimationClipInfo {
    name: string;
    track_name: string | null;
    animation_path: string;
}

interface AnimationList {
    clips: AnimationClipInfo[];
}

interface AnimationData {
    duration: number;
    fps: number;
    joint_count: number;
    joint_hashes: number[];
}

/**
 * Transform data for a single joint at a specific time
 */
interface JointTransform {
    rotation: [number, number, number, number];  // Quaternion [x, y, z, w]
    translation: [number, number, number];
    scale: [number, number, number];
}

/**
 * Animation pose containing all joint transforms at a specific time
 */
export interface AnimationPose {
    time: number;
    joints: Record<number, JointTransform>;  // joint_hash → transform
}

/**
 * Get list of available animations for a model
 */
export async function readAnimationList(sknPath: string): Promise<AnimationList> {
    return invokeCommand('read_animation_list', { sknPath });
}

/**
 * Read and parse an animation file
 */
export async function readAnimation(path: string, basePath?: string): Promise<AnimationData> {
    return invokeCommand('read_animation', { path, basePath });
}

/**
 * Evaluate animation at a specific time to get joint poses
 */
export async function evaluateAnimation(
    path: string,
    basePath: string | undefined,
    time: number
): Promise<AnimationPose> {
    return invokeCommand('evaluate_animation', { path, basePath, time });
}

/**
 * Resolve an asset path from a BIN file to an actual file path
 * Searches in WAD folders, extracted folders, and parent directories
 */
export async function resolveAssetPath(
    assetPath: string,
    binPath: string
): Promise<string> {
    return invokeCommand('resolve_asset_path', { assetPath, binPath });
}

// =============================================================================
// Auto-Update Commands
// =============================================================================

import type { UpdateInfo } from './types';

export async function getCurrentVersion(): Promise<string> {
    return invokeCommand('get_current_version');
}

export async function checkForUpdates(): Promise<UpdateInfo> {
    return invokeCommand('check_for_updates');
}

export async function downloadAndInstallUpdate(downloadUrl: string): Promise<void> {
    return invokeCommand('download_and_install_update', { downloadUrl });
}

// =============================================================================
// Checkpoint Commands
// =============================================================================

import type { Checkpoint, CheckpointDiff, CheckpointFileContent } from './types';

export async function createCheckpoint(
    projectPath: string,
    message: string,
    tags: string[] = []
): Promise<Checkpoint> {
    return invokeCommand('create_checkpoint', { projectPath, message, tags });
}

export async function listCheckpoints(projectPath: string): Promise<Checkpoint[]> {
    return invokeCommand('list_checkpoints', { projectPath });
}

export async function restoreCheckpoint(projectPath: string, checkpointId: string): Promise<void> {
    return invokeCommand('restore_checkpoint', { projectPath, checkpointId });
}

export async function compareCheckpoints(
    projectPath: string,
    fromId: string,
    toId: string
): Promise<CheckpointDiff> {
    return invokeCommand('compare_checkpoints', { projectPath, fromId, toId });
}

export async function deleteCheckpoint(projectPath: string, checkpointId: string): Promise<void> {
    return invokeCommand('delete_checkpoint', { projectPath, checkpointId });
}

export async function readCheckpointFile(
    projectPath: string,
    hash: string,
    filePath: string
): Promise<CheckpointFileContent> {
    return invokeCommand('read_checkpoint_file', { projectPath, hash, filePath });
}

export async function getFileChanges(projectPath: string): Promise<Record<string, string>> {
    return invokeCommand('get_file_changes', { projectPath });
}

// =============================================================================
// Audio / BNK Editor API
// =============================================================================

export async function parseAudioBank(path: string): Promise<AudioBankInfo> {
    return invokeCommand('parse_audio_bank', { path });
}

// All `*_bytes` audio commands send the bank/wem buffer as a raw request body
// (`tauri::ipc::Request<'_>` on Rust side) — `Array.from(uint8)` was dominating
// IPC time on multi-MB banks. Callers can pass either a `number[]` or
// `Uint8Array`; we coerce to bytes once at the boundary.
function toBytes(data: ArrayLike<number> | Uint8Array): Uint8Array {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export async function parseAudioBankBytes(data: ArrayLike<number> | Uint8Array): Promise<AudioBankInfo> {
    return invokeRaw('parse_audio_bank_bytes', toBytes(data));
}

export async function readAudioEntry(path: string, fileId: number): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('read_audio_entry', { path, fileId });
    return new Uint8Array(buf);
}

export async function readAudioEntryBytes(
    data: ArrayLike<number> | Uint8Array,
    fileId: number,
): Promise<Uint8Array> {
    const buf = await invokeRaw<ArrayBuffer>(
        'read_audio_entry_bytes',
        toBytes(data),
        { 'file-id': String(fileId) },
    );
    return new Uint8Array(buf);
}

export async function decodeWem(wemData: ArrayLike<number> | Uint8Array): Promise<DecodedAudio> {
    return invokeRaw('decode_wem', toBytes(wemData));
}

export async function parseBnkHirc(path: string): Promise<HircData | null> {
    return invokeCommand('parse_bnk_hirc', { path });
}

export async function parseBnkHircBytes(data: ArrayLike<number> | Uint8Array): Promise<HircData | null> {
    return invokeRaw('parse_bnk_hirc_bytes', toBytes(data));
}

export async function extractBinAudioEvents(data: ArrayLike<number> | Uint8Array): Promise<BinEventString[]> {
    return invokeRaw('extract_bin_audio_events', toBytes(data));
}

export async function mapAudioEvents(
    binData: number[],
    eventsBnkData: number[]
): Promise<EventMapping[]> {
    return invokeCommand('map_audio_events', { binData, eventsBnkData });
}

export async function replaceAudioEntry(
    bankData: number[],
    fileId: number,
    newWemData: number[]
): Promise<number[]> {
    return invokeCommand('replace_audio_entry', { bankData, fileId, newWemData });
}

export async function replaceAudioEntries(
    bankData: number[],
    replacements: { file_id: number; new_data: number[] }[]
): Promise<number[]> {
    return invokeCommand('replace_audio_entries', { bankData, replacements });
}

export async function silenceAudioEntry(
    bankData: number[],
    fileId: number
): Promise<number[]> {
    return invokeCommand('silence_audio_entry', { bankData, fileId });
}

export async function removeAudioEntry(
    bankData: number[],
    fileId: number
): Promise<number[]> {
    return invokeCommand('remove_audio_entry', { bankData, fileId });
}

export async function writeBnk(
    entries: { id: number; data: number[] }[]
): Promise<number[]> {
    return invokeCommand('write_bnk', { entries });
}

export async function writeWpk(
    entries: { id: number; data: number[] }[]
): Promise<number[]> {
    return invokeCommand('write_wpk', { entries });
}

export async function saveAudioFile(path: string, data: Uint8Array | number[]): Promise<void> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return invokeRaw('save_audio_file', bytes, { path });
}

// =============================================================================
// Fixer Commands (Hematite Integration)
// =============================================================================

import type { FixConfig, ProjectAnalysis, ProjectFixResult, BatchFixResult } from './types';

export async function getFixerConfig(): Promise<FixConfig> {
    return invokeCommand('get_fixer_config');
}

export async function analyzeProject(projectPath: string): Promise<ProjectAnalysis> {
    return invokeCommand('analyze_project', { projectPath });
}

export async function fixProject(
    projectPath: string,
    selectedFixIds: string[] = []
): Promise<ProjectFixResult> {
    return invokeCommand('fix_project', { projectPath, selectedFixIds });
}

export async function batchFixProjects(
    projectPaths: string[],
    selectedFixIds: string[] = []
): Promise<BatchFixResult> {
    return invokeCommand('batch_fix_projects', { projectPaths, selectedFixIds });
}

// =============================================================================
// File Management Commands (rename, delete, open, create, duplicate)
// =============================================================================

interface RenameResult {
    old_path: string;
    new_path: string;
    bin_updates: number;
}

export async function renameFile(
    projectPath: string,
    filePath: string,
    newName: string
): Promise<RenameResult> {
    return invokeCommand('rename_file', { projectPath, filePath, newName });
}

export async function deleteFile(
    projectPath: string,
    filePath: string
): Promise<void> {
    return invokeCommand('delete_file', { projectPath, filePath });
}

export async function openInExplorer(path: string): Promise<void> {
    return invokeCommand('open_in_explorer', { path });
}

export async function openWithDefaultApp(path: string): Promise<void> {
    return invokeCommand('open_with_default_app', { path });
}

// External apps (Jade/Quartz)
export async function detectJadeInstallation(): Promise<string | null> {
    return invokeCommand('detect_jade_installation', {});
}

export async function detectQuartzInstallation(): Promise<string | null> {
    return invokeCommand('detect_quartz_installation', {});
}

export async function launchJade(filePath: string, jadePath: string): Promise<void> {
    return invokeCommand('launch_jade', { filePath, jadePath });
}

export async function launchQuartz(filePath: string, quartzPath: string): Promise<void> {
    return invokeCommand('launch_quartz', { filePath, quartzPath });
}

export async function createDirectory(
    projectPath: string,
    dirPath: string
): Promise<string> {
    return invokeCommand('create_directory', { projectPath, dirPath });
}

export async function duplicateFile(
    projectPath: string,
    filePath: string
): Promise<string> {
    return invokeCommand('duplicate_file', { projectPath, filePath });
}

export async function moveFile(
    projectPath: string,
    sourcePath: string,
    destFolder: string,
): Promise<string> {
    return invokeCommand('move_file', { projectPath, sourcePath, destFolder });
}

export async function importExternalFiles(
    projectPath: string,
    destFolder: string,
    sources: string[],
): Promise<string[]> {
    return invokeCommand('import_external_files', { projectPath, destFolder, sources });
}

// =============================================================================
// Folder grid (custom file explorer)
// =============================================================================

export interface FolderEntry {
    name: string;
    relative_path: string;
    absolute_path: string;
    is_directory: boolean;
    size: number;
    extension: string;
}

export async function isDirectory(path: string): Promise<boolean> {
    return invokeCommand('is_directory', { path });
}

export async function listFolderContents(
    projectPath: string,
    folderPath: string,
): Promise<FolderEntry[]> {
    return invokeCommand('list_folder_contents', { projectPath, folderPath });
}

// =============================================================================
// BIN split (right-click "Split VFX to separate BIN")
// =============================================================================

export interface BinSplitClassGroup {
    class_hash: string;
    class_name: string | null;
    path_hashes: string[];
    is_vfx_default: boolean;
}

export interface BinSplitAnalysis {
    total_objects: number;
    groups: BinSplitClassGroup[];
}

export interface BinSplitResult {
    moved: number;
    link_added: string;
}

export async function analyzeBinForSplit(binPath: string): Promise<BinSplitAnalysis> {
    return invokeCommand('analyze_bin_for_split', { binPath });
}

export async function splitBinEntries(
    binPath: string,
    outputFilename: string,
    pathHashes: string[],
): Promise<BinSplitResult> {
    return invokeCommand('split_bin_entries', { binPath, outputFilename, pathHashes });
}

export interface BinSplitSourceInfo {
    path: string;
    rel_path: string;
    object_count: number;
}

export interface BinSplitFolderAnalysis {
    sources: BinSplitSourceInfo[];
    total_objects: number;
    groups: BinSplitClassGroup[];
    suggested_owner: string;
}

export async function analyzeFolderForSplit(folderPath: string): Promise<BinSplitFolderAnalysis> {
    return invokeCommand('analyze_folder_for_split', { folderPath });
}

export async function splitFolderEntries(
    folderPath: string,
    sourcePaths: string[],
    ownerPath: string,
    outputFilename: string,
    pathHashes: string[],
): Promise<BinSplitResult> {
    return invokeCommand('split_folder_entries', {
        folderPath, sourcePaths, ownerPath, outputFilename, pathHashes,
    });
}

export interface BinOrganizePreview {
    sources: BinSplitSourceInfo[];
    vfx_objects_estimate: number;
    main_objects_estimate: number;
    suggested_owner: string;
    vfx_filename: string;
}

export interface BinOrganizeResult {
    vfx_objects_moved: number;
    main_objects_merged: number;
    sources_deleted: string[];
    links_pruned: number;
    vfx_link_added: string;
}

export async function previewOrganizeVfx(folderPath: string): Promise<BinOrganizePreview> {
    return invokeCommand('preview_organize_vfx', { folderPath });
}

export async function organizeBinsVfx(
    folderPath: string,
    ownerPath: string,
    vfxFilename: string,
): Promise<BinOrganizeResult> {
    return invokeCommand('organize_bins_vfx', { folderPath, ownerPath, vfxFilename });
}

// =============================================================================
// Fantome Import Commands
// =============================================================================

export interface FantomeMetadata {
    author: string | null;
    name: string | null;
    description: string | null;
    version: string | null;
}

export interface FantomeAnalysis {
    champion: string | null;
    skin_ids: number[];
    is_champion_mod: boolean;
    file_count: number;
    file_paths: string[];
    metadata: FantomeMetadata | null;
}

export interface ImportOptions {
    refather: boolean;
    creator_name: string | null;
    project_name: string | null;
    target_skin_id: number | null;
    cleanup_unused: boolean;
    match_from_league: boolean;
    league_path: string | null;
    use_jade: boolean | null;
}

export async function analyzeFantome(wadPath: string): Promise<FantomeAnalysis> {
    return invokeCommand('analyze_fantome', { wadPath });
}

export async function importFantomeWad(
    wadPath: string,
    projectDir: string,
    options: ImportOptions
): Promise<Project> {
    return invokeCommand('import_fantome_wad', { wadPath, projectDir, options });
}

// =============================================================================
// ModPkg Import Commands
// =============================================================================

export interface ModpkgAnalysis {
    champion: string | null;
    skin_ids: number[];
    is_champion_mod: boolean;
    file_count: number;
    file_paths: string[];
    name: string | null;
    display_name: string | null;
    description: string | null;
    version: string | null;
    authors: string[];
    has_thumbnail: boolean;
}

export async function analyzeModpkg(modpkgPath: string): Promise<ModpkgAnalysis> {
    return invokeCommand('analyze_modpkg', { modpkgPath });
}

export async function importModpkg(
    modpkgPath: string,
    projectDir: string,
    options: ImportOptions
): Promise<Project> {
    return invokeCommand('import_modpkg', { modpkgPath, projectDir, options });
}

// =============================================================================
// HUD Editor Commands
// =============================================================================

export interface HudData {
    type: string;
    version: number;
    linked: string[];
    entries: Record<string, HudEntry>;
}

export interface HudEntry {
    name: string;
    type: string;
    enabled: boolean;
    Layer: number;
    position?: HudPosition;
    TextureData?: TextureData;
    Scene?: string;
    extra?: Record<string, unknown>;
}

export interface HudPosition {
    UIRect: UiRect;
    Anchors?: Anchors;
}

export interface UiRect {
    position: Vec2;
    Size: Vec2;
    SourceResolutionWidth: number;
    SourceResolutionHeight: number;
}

export interface Vec2 {
    x: number;
    y: number;
}

export interface Anchors {
    Anchor: Vec2;
}

export interface TextureData {
    mTextureName: string;
    mTextureUV?: Vec4;
}

export interface Vec4 {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface HudFileStats {
    total_elements: number;
    by_type: Record<string, number>;
    by_layer: Record<number, number>;
}

export async function parseHudRitobinFile(filePath: string): Promise<HudData> {
    return invokeCommand('parse_hud_ritobin_file', { filePath });
}

export async function saveHudRitobinFile(
    filePath: string,
    data: HudData,
    originalContent: string
): Promise<void> {
    return invokeCommand('save_hud_ritobin_file', { filePath, data, originalContent });
}

export async function getHudFileStats(filePath: string): Promise<HudFileStats> {
    return invokeCommand('get_hud_file_stats', { filePath });
}

// =============================================================================
// Dev Commands (Schema Aggregation)
// =============================================================================

export interface SchemaStats {
    wads_scanned: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
    total_fields: number;
    output_path: string;
}

export async function aggregateBinSchema(leaguePath: string): Promise<SchemaStats> {
    return invokeCommand('aggregate_bin_schema', { leaguePath });
}

export interface ChampionSchemaStats {
    wads_scanned: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
    total_fields: number;
    output_path: string;
}

export async function aggregateChampionBinSchema(leaguePath: string): Promise<ChampionSchemaStats> {
    return invokeCommand('aggregate_champion_bin_schema', { leaguePath });
}

// =============================================================================
// Settings Commands (disk-based settings)
// =============================================================================

export interface FlintSettings {
    schemaVersion: number;
    leaguePath: string | null;
    leaguePathPbe: string | null;
    defaultProjectPath: string | null;
    creatorName: string | null;
    creatorDescription: string | null;
    creatorHome: string | null;
    creatorTip: string | null;
    autoUpdateEnabled: boolean;
    skippedUpdateVersion: string | null;
    recentProjects: RecentProject[];
    savedProjects: SavedProject[];
    ltkManagerModPath: string | null;
    autoSyncToLauncher: boolean;
    celestialModPath: string | null;
    preferredLauncher: 'ltk' | 'celestial' | null;
    binConverterEngine: string;
    jadePath: string | null;
    quartzPath: string | null;
    selectedTheme: string | null;
}

export async function getAppHome(): Promise<string> {
    return invokeCommand('get_app_home');
}

export async function getSettings(): Promise<FlintSettings> {
    return invokeCommand('get_settings');
}

export async function saveSettings(settings: FlintSettings): Promise<void> {
    return invokeCommand('save_settings', { settings });
}

export async function migrateFromLocalStorage(legacyJson: string): Promise<void> {
    return invokeCommand('migrate_from_localstorage', { legacyJson });
}

export interface MigrateProjectsResult {
    moved: number;
    skipped: number;
}

export async function migrateProjects(): Promise<MigrateProjectsResult> {
    return invokeCommand('migrate_projects');
}

// Theme commands

export interface ThemeInfo {
    id: string;
    name: string;
}

export async function listThemes(): Promise<ThemeInfo[]> {
    return invokeCommand('list_themes');
}

export async function loadTheme(themeId: string): Promise<Record<string, unknown>> {
    return invokeCommand('load_theme', { themeId });
}

export async function createDefaultTheme(): Promise<string> {
    return invokeCommand('create_default_theme');
}

/** Write the built-in preset themes to disk if missing (idempotent). */
export async function seedBuiltinThemes(): Promise<void> {
    return invokeCommand('seed_builtin_themes');
}

// =============================================================================
// Compare with original / per-file backups
// =============================================================================

export interface OriginalFileMeta {
    /** Did we locate a chunk in the original WAD that matches this project file? */
    found: boolean;
    /** True when the matched WAD-internal path is an exact (case-insensitive)
     *  match. False when matched via the suffix-tolerant fallback. */
    exact: boolean;
    /** Did we locate the original WAD file in the League install? */
    wad_found: boolean;
    /** Absolute path of the original WAD (null if not located). */
    wad_path: string | null;
    /** Hex hash of the matched chunk — pass to `readWadChunkData` to fetch bytes. */
    matched_hash: string | null;
    /** WAD-internal path of the matched chunk. */
    matched_internal_path: string | null;
    /** Internal path we derived from the project file. */
    queried_internal_path: string;
    /** WAD folder name we derived (e.g. `Ambessa.wad.client`). */
    queried_wad_name: string;
}

/**
 * Look up the original chunk for a project file. Tolerates suffix changes
 * between patches — e.g. `crazygood.ambessa.tex` ↔ `crazygood.boba.tex`.
 *
 * The returned `meta.matched_hash` + `meta.wad_path` can be fed to
 * `readWadChunkData` to fetch the actual bytes for diffing.
 */
export async function findOriginalFile(
    leaguePath: string,
    projectPath: string,
    fileRelPath: string,
): Promise<OriginalFileMeta> {
    return invokeCommand('find_original_file', { leaguePath, projectPath, fileRelPath });
}

export async function hasFileBackup(projectPath: string, fileRelPath: string): Promise<boolean> {
    return invokeCommand('has_file_backup', { projectPath, fileRelPath });
}

export async function createFileBackup(projectPath: string, fileRelPath: string): Promise<void> {
    return invokeCommand('create_file_backup', { projectPath, fileRelPath });
}

export async function readFileBackup(projectPath: string, fileRelPath: string): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('read_file_backup', { projectPath, fileRelPath });
    return new Uint8Array(buf);
}

export async function deleteFileBackup(projectPath: string, fileRelPath: string): Promise<void> {
    return invokeCommand('delete_file_backup', { projectPath, fileRelPath });
}

// ---------------------------------------------------------------------------
// Chroma porting
// ---------------------------------------------------------------------------

export interface ChromaBinEntry {
    path: string;
    skin_num: number;
}

export interface ChromaLink {
    base_bin: string;
    base_skin_num: number;
    chroma_bins: ChromaBinEntry[];
}

export interface ChromaLinks {
    links: ChromaLink[];
}

/** Port every BIN under skin{baseSkinNum}/ to each requested chroma skin num.
 *  Returns the number of BIN files written. */
export async function portProjectToChromas(
    projectPath: string,
    champion: string,
    baseSkinNum: number,
    chromaSkinNums: number[],
): Promise<number> {
    return invokeCommand('port_project_to_chromas', {
        projectPath,
        champion,
        baseSkinNum,
        chromaSkinNums,
    });
}

/** Re-derive all chroma BINs linked to `baseBinPath` from the current base content.
 *  Returns project-relative paths of synced chroma BINs. */
export async function syncChromaBins(
    projectPath: string,
    baseBinPath: string,
    champion: string,
    baseSkinNum: number,
): Promise<string[]> {
    return invokeCommand('sync_chroma_bins', {
        projectPath,
        baseBinPath,
        champion,
        baseSkinNum,
    });
}

/** Return the chroma-links.json manifest for the given project. */
export async function getChromaLinks(projectPath: string): Promise<ChromaLinks> {
    return invokeCommand('get_chroma_links', { projectPath });
}
