import type { WadGrepFile } from '../../../lib/api/wadGrep';
import type { BinSearchMatch } from '../../../lib/api/bin';

export interface WadGrepGroup {
    path: string;
    name: string;
    files: WadGrepFile[];
    matches: number;
}
export type WadGrepRow =
    | { kind: 'wad'; group: WadGrepGroup }
    | { kind: 'file'; file: WadGrepFile }
    | { kind: 'hit'; file: WadGrepFile; hit: BinSearchMatch };

export const grepFileKey = (file: WadGrepFile) => `${file.wad_path}::${file.hash}`;

export function groupWadMatches(files: WadGrepFile[]): WadGrepGroup[] {
    const groups = new Map<string, WadGrepGroup>();
    for (const file of files) {
        let group = groups.get(file.wad_path);
        if (!group) {
            group = { path: file.wad_path, name: file.wad_path.split(/[\\/]/).pop() ?? file.wad_path, files: [], matches: 0 };
            groups.set(file.wad_path, group);
        }
        group.files.push(file);
        group.matches += file.matches.length + file.extra;
    }
    return [...groups.values()];
}

export function flattenWadMatches(groups: WadGrepGroup[], openWads: Set<string>, openFiles: Set<string>): WadGrepRow[] {
    const rows: WadGrepRow[] = [];
    for (const group of groups) {
        rows.push({ kind: 'wad', group });
        if (!openWads.has(group.path)) continue;
        for (const file of group.files) {
            rows.push({ kind: 'file', file });
            if (openFiles.has(grepFileKey(file))) {
                for (const hit of file.matches) rows.push({ kind: 'hit', file, hit });
            }
        }
    }
    return rows;
}
