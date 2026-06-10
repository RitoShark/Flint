import { invokeCommand, invokeRaw, utf8Decoder } from './core';

export async function readFileBytes(path: string, opts: { silent?: boolean } = {}): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('read_file_bytes', { path }, opts);
    return new Uint8Array(buf);
}

export interface FileInfo {
    path: string;
    size: number;
    fileType: string;
    extension: string;
    dimensions: [number, number] | null;
}

export async function readFileInfo(path: string): Promise<FileInfo> {
    return invokeCommand('read_file_info', { path });
}

export async function readTextFile(path: string): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('read_text_file', { path });
    return utf8Decoder.decode(buf);
}

export async function writeTextFile(path: string, content: string): Promise<void> {
    return invokeCommand('write_text_file', { path, content });
}

export async function saveFileBytes(path: string, data: Uint8Array | number[]): Promise<void> {
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
// File management commands (rename, delete, open, create, duplicate)
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

export async function deleteFile(projectPath: string, filePath: string): Promise<void> {
    return invokeCommand('delete_file', { projectPath, filePath });
}

export async function openInExplorer(path: string): Promise<void> {
    return invokeCommand('open_in_explorer', { path });
}

export async function openWithDefaultApp(path: string): Promise<void> {
    return invokeCommand('open_with_default_app', { path });
}

export async function createDirectory(projectPath: string, dirPath: string): Promise<string> {
    return invokeCommand('create_directory', { projectPath, dirPath });
}

export async function duplicateFile(projectPath: string, filePath: string): Promise<string> {
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

/** Copy files/folders from one project into a folder of another project. */
export async function copyBetweenProjects(
    sourceProject: string,
    sourceRelPaths: string[],
    destProject: string,
    destFolder: string,
): Promise<string[]> {
    return invokeCommand('copy_between_projects', { sourceProject, sourceRelPaths, destProject, destFolder });
}

/** Move files/folders from one project into a folder of another project. */
export async function moveBetweenProjects(
    sourceProject: string,
    sourceRelPaths: string[],
    destProject: string,
    destFolder: string,
): Promise<string[]> {
    return invokeCommand('move_between_projects', { sourceProject, sourceRelPaths, destProject, destFolder });
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

/**
 * Combined "is this a dir, and if not what's the file info" — single IPC
 * call replacing the isDirectory() + readFileInfo() sequence in PreviewPanel.
 *
 * `info` is `null` when the path is a directory or does not exist.
 *
 * Field names match the existing `FileInfo` snake_case wire shape so consumers
 * already using `info.file_type` keep working unchanged.
 */
export interface PathInspection {
    is_directory: boolean;
    info: FileInfo | null;
}

export async function inspectPath(path: string): Promise<PathInspection> {
    return invokeCommand('inspect_path', { path });
}
