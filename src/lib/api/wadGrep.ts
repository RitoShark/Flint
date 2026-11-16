import { invokeCommand } from './core';
import type { BinSearchMatch, BinSearchOptions } from './bin';

export interface WadGrepFile {
    wad_path: string;
    path: string;
    hash: string;
    matches: BinSearchMatch[];
    extra: number;
}
export interface WadGrepResult {
    files: WadGrepFile[];
    scanned: number;
    failed: number;
    unresolved: number;
    truncated: boolean;
    cancelled: boolean;
}
export const beginWadGrep = () => invokeCommand<string>('begin_wad_grep');
export const cancelWadGrep = (id: string) => invokeCommand<void>('cancel_wad_grep', { id });
export const grepGameWads = (id: string, wadPaths: string[], query: string, options: BinSearchOptions, fileTypes: string[], references: boolean) =>
    invokeCommand<WadGrepResult>('grep_game_wads', { id, wadPaths, query, options, fileTypes, references });
