/**
 * Flint - Tauri Bridge Layer
 * Async wrappers for all Tauri commands with error handling
 */

import { invoke } from '@tauri-apps/api/core';
import type { HashStatus, Project, FileTreeNode, Champion } from './types';

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
            'discover_champions': 'Failed to discover champions.',
            'get_champion_skins': 'Failed to get skins for this champion.',
            'search_champions': 'Champion search failed.',
            'create_project': 'Failed to create project.',
            'open_project': 'Failed to open project. The project file may be corrupted.',
            'save_project': 'Failed to save project.',
            'list_project_files': 'Failed to list project files.',
            'preconvert_project_bins': 'Failed to pre-convert BIN files.',
            'read_wad': 'Failed to read WAD file. The file may be corrupted.',
            'get_wad_chunks': 'Failed to read WAD contents.',
            'extract_wad': 'Failed to extract files from WAD.',
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
            'extract_asset_references': 'Failed to extract asset references.',
            'validate_assets': 'Asset validation failed.',
            'export_fantome': 'Failed to export Fantome package.',
            'export_modpkg': 'Failed to export modpkg package.',
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
            'open_project': 'Try opening a different project or create a new one.',
            'save_project': 'Check that the project folder still exists and is writable.',
            'save_ritobin_to_bin': 'Check for syntax errors in the BIN editor.',
            'decode_dds_to_png': 'The texture format may not be supported.',
            'read_file_bytes': 'Check that the file exists and is accessible.',
            'export_fantome': 'Ensure all project files are saved.',
        };
        return suggestions[this.command] || null;
    }
}

/**
 * Wrap a Tauri command with consistent error handling
 */
async function invokeCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
        return await invoke<T>(command, args);
    } catch (error) {
        console.error(`[Flint] Command "${command}" failed:`, error);
        throw new FlintError(command, error);
    }
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
}

export async function createProject(params: CreateProjectParams): Promise<Project> {
    return invokeCommand('create_project', {
        name: params.name,
        champion: params.champion,
        skinId: params.skin,
        outputPath: params.projectPath,
        leaguePath: params.leaguePath,
        creatorName: params.creatorName,
    });
}

export async function openProject(projectPath: string): Promise<Project> {
    return invokeCommand('open_project', { path: projectPath });
}

export async function saveProject(project: Project): Promise<void> {
    return invokeCommand('save_project', { project });
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

export async function preconvertProjectBins(projectPath: string): Promise<number> {
    return invokeCommand('preconvert_project_bins', { projectPath });
}

// =============================================================================
// WAD Commands
// =============================================================================

export async function readWad(wadPath: string): Promise<{ version: string; chunkCount: number }> {
    return invokeCommand('read_wad', { wadPath });
}

export async function getWadChunks(
    wadPath: string
): Promise<Array<{ hash: string; path: string | null; size: number }>> {
    return invokeCommand('get_wad_chunks', { wadPath });
}

export async function extractWad(
    wadPath: string,
    outputPath: string,
    hashes: string[] | null = null
): Promise<{ extracted: number }> {
    return invokeCommand('extract_wad', { wadPath, outputPath, hashes });
}

// =============================================================================
// BIN Commands
// =============================================================================

export async function convertBinToText(binData: Uint8Array): Promise<string> {
    return invokeCommand('convert_bin_to_text', { binData: Array.from(binData) });
}

export async function convertBinToJson(binData: Uint8Array): Promise<unknown> {
    return invokeCommand('convert_bin_to_json', { binData: Array.from(binData) });
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

export async function parseBinFileToText(path: string): Promise<string> {
    return invokeCommand('parse_bin_file_to_text', { path });
}

export async function readOrConvertBin(binPath: string): Promise<string> {
    return invokeCommand('read_or_convert_bin', { binPath });
}

export async function saveRitobinToBin(binPath: string, content: string): Promise<void> {
    return invokeCommand('save_ritobin_to_bin', { binPath, content });
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

export async function readFileBytes(path: string): Promise<Uint8Array> {
    const result = await invokeCommand<number[]>('read_file_bytes', { path });
    return new Uint8Array(result);
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

export async function readTextFile(path: string): Promise<string> {
    return invokeCommand('read_text_file', { path });
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

interface ExportParams {
    projectPath: string;
    outputPath: string;
    format: 'fantome' | 'modpkg';
}

export async function exportProject(params: ExportParams): Promise<{ path: string }> {
    if (params.format === 'fantome') {
        return invokeCommand('export_fantome', {
            projectPath: params.projectPath,
            outputPath: params.outputPath,
        });
    }
    return invokeCommand('export_modpkg', {
        projectPath: params.projectPath,
        outputPath: params.outputPath,
    });
}
