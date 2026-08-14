/**
 * Naming for manually-picked `.anm` folders.
 *
 * League ships clip files with the skin baked into the filename
 * (`idle01.skins_diana_skin77.anm`), which is unreadable in a narrow dropdown.
 * We show the leading segment (`idle01`) instead — but only where that stays
 * unambiguous: if two files in the same folder collapse to the same short
 * label, BOTH keep their full stem, so the artist can still tell them apart.
 *
 * Kept free of Tauri/Babylon imports so it unit-tests in the node environment
 * vitest runs in — the same convention `sknAlpha.ts` and `cameraFraming.ts`
 * follow.
 */

export interface AnmFile {
    /** File name including the `.anm` extension. */
    fileName: string;
    /** Absolute path, handed straight to the `read_animation` command. */
    path: string;
}

export interface AnmClipOption {
    /** Display label for the Clip dropdown. */
    name: string;
    /** Absolute path of the `.anm`. */
    animation_path: string;
    track_name: string | null;
}

/** Strip the `.anm` extension, then everything from the first dot onward
 *  (`idle01.skins_diana_skin77` → `idle01`). Files with no inner dot are
 *  unchanged. */
export function shortClipLabel(fileName: string): string {
    const stem = fileName.replace(/\.anm$/i, '');
    const dot = stem.indexOf('.');
    return dot > 0 ? stem.slice(0, dot) : stem;
}

/** Full stem: just the `.anm` extension removed. */
export function fullClipLabel(fileName: string): string {
    return fileName.replace(/\.anm$/i, '');
}

/**
 * Build the dropdown's clip list from the `.anm` files in a picked folder.
 * Short labels are used where unique; every member of a colliding group falls
 * back to its full stem. Sorted by the final display label so the dropdown
 * reads alphabetically.
 */
export function buildAnmClips(files: AnmFile[]): AnmClipOption[] {
    const shortCounts = new Map<string, number>();
    for (const f of files) {
        const short = shortClipLabel(f.fileName);
        shortCounts.set(short, (shortCounts.get(short) ?? 0) + 1);
    }

    const clips = files.map((f) => {
        const short = shortClipLabel(f.fileName);
        const collides = (shortCounts.get(short) ?? 0) > 1;
        return {
            name: collides ? fullClipLabel(f.fileName) : short,
            animation_path: f.path,
            track_name: null,
        };
    });

    clips.sort((a, b) => a.name.localeCompare(b.name));
    return clips;
}
