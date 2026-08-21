import { flushSync } from 'react-dom';
import { useAppMetadataStore } from './appMetadataStore';
import { editorSessionStore } from './editorSessionStore';
import { useFileEditorStore } from './fileEditorStore';
import { useProjectTabStore } from './projectTabStore';

/* Length-preserving on purpose: callers slice the ORIGINAL path by an offset measured here. */
function comparablePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * `candidate` rewritten for a rename of `oldRel` → `newRel`, or null when the
 * rename doesn't touch it. Both a direct hit and a path beneath a renamed
 * folder are rewritten.
 */
export function retargetRelativePath(
    candidate: string,
    oldRel: string,
    newRel: string,
): string | null {
    const current = comparablePath(candidate);
    const old = comparablePath(oldRel);
    if (current === old) return newRel;
    if (current.startsWith(`${old}/`)) return newRel + candidate.slice(oldRel.length);
    return null;
}

/**
 * Follow a project-file rename through everything keyed by the file's path:
 * open standalone editor tabs, the file-tree selection, the cached (possibly
 * dirty) editor text, and the file's version/status metadata. Without this an
 * open editor keeps pointing at the old name and reloads into a not-found
 * state instead of staying where it was.
 */
export function followRename(projectPath: string, oldRel: string, newRel: string): void {
    const oldFull = `${projectPath}/${oldRel}`;
    const newFull = `${projectPath}/${newRel}`;

    /* Editors are keyed by path, so retargeting unmounts them — and BinEditor writes its live
       text to the session cache from that unmount. Flush it BEFORE moving the cache entry, or
       the move carries the stale load-time text and unsaved edits are lost. */
    flushSync(() => {
        useFileEditorStore.getState().retargetFile(oldFull, newFull);

        const projectTab = useProjectTabStore.getState();
        for (const tab of projectTab.openTabs) {
            if (!tab.selectedFile) continue;
            if (comparablePath(tab.projectPath) !== comparablePath(projectPath)) continue;
            const moved = retargetRelativePath(tab.selectedFile, oldRel, newRel);
            if (moved !== null) projectTab.setSelectedFile(tab.id, moved);
        }
    });

    editorSessionStore.rename(oldFull, newFull);
    useAppMetadataStore.getState().renameFilePath(oldFull, newFull);
}
