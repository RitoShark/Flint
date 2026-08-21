import { formatCombo, parseCombo } from './combo';
import type { ScopeId, Shortcut } from './types';

/**
 * Turn the manifest into display rows.
 *
 * The sheet is generated rather than hand-maintained, which is the whole reason
 * `keys` and `label` live in the same record — a shortcut cannot appear here with
 * the wrong key, and a new binding cannot be forgotten.
 */

export interface CheatSheetRow {
    /** Display-formatted combo, e.g. 'Ctrl+Shift+Tab' or '↓'. */
    keys: string;
    label: string;
    /** Lets the UI note when a shortcut only applies to a focused surface. */
    scope: ScopeId;
}

export interface CheatSheetGroup {
    group: string;
    rows: CheatSheetRow[];
}

export function buildCheatSheet(shortcuts: readonly Shortcut[]): CheatSheetGroup[] {
    // Insertion-ordered Map: groups come out in first-appearance order, so the
    // manifest's editorial ordering carries through instead of being alphabetised.
    const groups = new Map<string, CheatSheetRow[]>();

    for (const shortcut of shortcuts) {
        const row: CheatSheetRow = {
            keys: formatCombo(parseCombo(shortcut.keys)),
            label: shortcut.label,
            scope: shortcut.scope,
        };
        const existing = groups.get(shortcut.group);
        if (existing) existing.push(row);
        else groups.set(shortcut.group, [row]);
    }

    return [...groups.entries()].map(([group, rows]) => ({ group, rows }));
}

/** Human-readable note for scopes that only apply to a focused surface. */
export function scopeHint(scope: ScopeId): string | null {
    switch (scope) {
        case 'file-tree': return 'when the file tree is focused';
        case 'wad-tree': return 'when the WAD list is focused';
        case 'model-preview': return 'in the 3D preview';
        case 'zoomable': return 'in a zoomable viewer';
        case 'wad-explorer': return 'in WAD Explorer';
        case 'modal': return 'when a dialog is open';
        case 'global': return null;
        default: return null;
    }
}
