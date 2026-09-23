/**
 * Which of a project's BINs the RubyRe button can send. RubyRe opens a skin BIN (the
 * character, its VFX and animations follow from it) or a map BIN, so those are what the
 * button offers; linked data and animation BINs only make sense reached from one of them.
 * Pure: works on the project tab's in-memory file tree.
 */
import type { FileTreeNode } from './types';

const SKIN_BIN = /(?:^|\/)data\/characters\/[^/]+\/skins\/skin\d+\.bin$/i;
const MAP_BIN = /(?:^|\/)data\/maps\/shipping\/map(\d+)\/map\1\.bin$/i;
const ANIMATION_BIN = /\/animations\/[^/]+\.bin$/i;

function allBins(root: FileTreeNode | null): string[] {
    if (!root) return [];
    const out: string[] = [];
    const stack: FileTreeNode[] = [root];
    while (stack.length) {
        const node = stack.pop()!;
        const path = node.path.replaceAll('\\', '/');
        if (!node.isDirectory && /\.bin$/i.test(path)) out.push(path);
        if (node.children) stack.push(...node.children);
    }
    return out;
}

/** Project-relative paths of the BINs worth opening in RubyRe, in natural order (skin2 before
 *  skin10). Skin and map BINs when the project has any; otherwise every BIN that is not an
 *  animation BIN, so an unusual project still offers something. */
export function rubyBinCandidates(root: FileTreeNode | null): string[] {
    const bins = allBins(root);
    const main = bins.filter((p) => SKIN_BIN.test(p) || MAP_BIN.test(p));
    const pool = main.length ? main : bins.filter((p) => !ANIMATION_BIN.test(p));
    return [...new Set(pool)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/** A candidate as the chooser shows it: the file name, and where it sits inside its WAD folder. */
export function rubyBinLabel(rel: string): { name: string; where: string } {
    const norm = rel.replaceAll('\\', '/');
    const name = norm.slice(norm.lastIndexOf('/') + 1);
    const dir = norm.slice(0, Math.max(0, norm.lastIndexOf('/')));
    const wadAt = dir.toLowerCase().indexOf('.wad.client/');
    return { name, where: wadAt >= 0 ? dir.slice(wadAt + '.wad.client/'.length) : dir };
}

/** The absolute Windows path RubyRe is handed for a project-relative file. */
export function projectFilePath(projectPath: string, rel: string): string {
    return `${projectPath}/${rel}`.replace(/\//g, '\\');
}
