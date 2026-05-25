import { invokeCommand } from './core';

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
