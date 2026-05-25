import { invokeCommand, invokeRaw } from './core';
import type { Project, ProjectKind, FileTreeNode } from '../types';

interface CreateProjectParams {
    name: string;
    champion: string;
    skin: number;
    projectPath: string;
    leaguePath: string;
    creatorName?: string;
    useJade?: boolean;
    isPbe?: boolean;
    isTft?: boolean;
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
        isTft: params.isTft,
    });
}

interface CreateLoadingScreenParams {
    name: string;
    projectPath: string;
    leaguePath: string;
    creatorName: string;
    spritesheetRgbaDeflated: Uint8Array;
    frameWidth: number;
    frameHeight: number;
    sheetWidth: number;
    sheetHeight: number;
    fps: number;
    totalFrames: number;
    cols: number;
    rows: number;
}

function packPayload(params: CreateLoadingScreenParams): Uint8Array {
    const encoder = new TextEncoder();
    const nameBytes = encoder.encode(params.name);
    const projectPathBytes = encoder.encode(params.projectPath);
    const leaguePathBytes = encoder.encode(params.leaguePath);
    const creatorNameBytes = encoder.encode(params.creatorName);

    const totalSize =
        4 + nameBytes.length +
        4 + projectPathBytes.length +
        4 + leaguePathBytes.length +
        4 + creatorNameBytes.length +
        8 * 4 +
        params.spritesheetRgbaDeflated.length;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    const writeStringBytes = (bytes: Uint8Array) => {
        view.setUint32(offset, bytes.length, true);
        offset += 4;
        new Uint8Array(buffer, offset, bytes.length).set(bytes);
        offset += bytes.length;
    };

    writeStringBytes(nameBytes);
    writeStringBytes(projectPathBytes);
    writeStringBytes(leaguePathBytes);
    writeStringBytes(creatorNameBytes);

    view.setUint32(offset, params.frameWidth, true); offset += 4;
    view.setUint32(offset, params.frameHeight, true); offset += 4;
    view.setUint32(offset, params.sheetWidth, true); offset += 4;
    view.setUint32(offset, params.sheetHeight, true); offset += 4;
    view.setFloat32(offset, params.fps, true); offset += 4;
    view.setFloat32(offset, params.totalFrames, true); offset += 4;
    view.setFloat32(offset, params.cols, true); offset += 4;
    view.setFloat32(offset, params.rows, true); offset += 4;

    new Uint8Array(buffer, offset, params.spritesheetRgbaDeflated.length).set(params.spritesheetRgbaDeflated);
    return new Uint8Array(buffer);
}

function decodeProjectPayload(bytes: Uint8Array): Project {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const utf8 = new TextDecoder('utf-8');
    let off = 0;

    const readString = (): string => {
        const len = view.getUint32(off, true); off += 4;
        const s = utf8.decode(bytes.subarray(off, off + len));
        off += len;
        return s;
    };

    const pid = readString();
    const name = readString();
    const displayName = readString();
    const kind = readString() as ProjectKind;
    const champion = readString();
    const skinId = view.getUint32(off, true); off += 4;
    const mapId = readString() || null;
    const creator = readString();
    const version = readString();
    const description = readString();
    const projectPath = readString();

    return {
        pid,
        name,
        display_name: displayName,
        kind,
        champion,
        skin_id: skinId,
        map_id: mapId,
        creator,
        version,
        description,
        project_path: projectPath,
    };
}

export async function createLoadingScreenProject(params: CreateLoadingScreenParams): Promise<Project> {
    const payload = packPayload(params);
    const buf = await invokeRaw<ArrayBuffer>('create_loading_screen_project', payload);
    return decodeProjectPayload(new Uint8Array(buf));
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
export async function discoverProjects(projectsRoot: string): Promise<import('../types').ProjectListing[]> {
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
                    if (a.isDirectory !== b.isDirectory) {
                        return a.isDirectory ? -1 : 1;
                    }
                    return a.name.localeCompare(b.name);
                });
        }

        return node;
    };

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

/**
 * Combined "open + list" — single IPC call replacing the prior
 * openProject() + listProjectFiles() sequence in FileTree.handleOpenProject.
 */
export interface OpenProjectWithTreeResult {
    project: Project;
    fileTree: FileTreeNode;
}

export async function openProjectWithTree(projectPath: string): Promise<OpenProjectWithTreeResult> {
    const raw = await invokeCommand<{
        project: Project;
        file_tree: Record<string, BackendFileEntry>;
    }>('open_project_with_tree', { path: projectPath });
    return {
        project: raw.project,
        fileTree: transformFileTree(raw.file_tree, 'Project'),
    };
}
