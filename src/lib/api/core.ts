/**
 * Flint API core — error class, IPC tracing, and the low-level
 * `invokeCommand` / `invokeRaw` wrappers everything else builds on.
 */

import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';

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
            'aggregate_troybin_schema': 'Failed to aggregate troybin schema.',
            'extract_all_luabins': 'Failed to extract luabin files.',
            'find_original_file': 'Failed to look up original file.',
            'create_file_backup': 'Failed to create backup.',
            'read_file_backup': 'Failed to read backup file.',
            'has_file_backup': 'Failed to check backup.',
            'delete_file_backup': 'Failed to delete backup.',
        };
        return messages[this.command] || this.message;
    }

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

/* IPC tracing — flip with `localStorage.flintIpcTrace = '1'` then reload, or
   set window.__FLINT_IPC_TRACE = true at runtime. Default ON in dev. */
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

export async function invokeCommand<T>(
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

export async function invokeRaw<T>(
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

export const utf8Decoder = new TextDecoder('utf-8');
