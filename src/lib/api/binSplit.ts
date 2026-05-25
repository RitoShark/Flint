import { invokeCommand } from './core';

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

export async function getVfxFilename(folderPath: string): Promise<string> {
    return invokeCommand('get_vfx_filename_command', { folderPath });
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
