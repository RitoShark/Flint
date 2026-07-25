import type { Shortcut } from './types';

/**
 * Every keyboard shortcut in Flint, as data.
 *
 * This is the single source of truth for both the binding and its documentation —
 * the cheat sheet renders straight from here, so a key and its description cannot
 * drift apart.
 *
 * Rules enforced by manifest.test.ts:
 *  - ids unique
 *  - `keys` parseable and written in canonical `ctrl+alt+shift+key` order, lowercase
 *  - no two entries share a combo *within the same scope* (across scopes is the point)
 *  - label and group non-empty
 *
 * Grows one phase at a time; a shortcut is declared here only once something
 * actually handles it, so the cheat sheet never advertises a dead key.
 */
export const SHORTCUTS: readonly Shortcut[] = [
    // ── General ──────────────────────────────────────────────────────────────
    {
        id: 'app.newProject',
        keys: 'ctrl+n',
        label: 'New project',
        group: 'General',
        scope: 'global',
    },
    {
        id: 'app.save',
        keys: 'ctrl+s',
        label: 'Save',
        group: 'General',
        scope: 'global',
        // Must reach the app from inside the Monaco bin editor.
        allowInTextEntry: true,
    },
    {
        id: 'app.settings',
        keys: 'ctrl+,',
        label: 'Settings',
        group: 'General',
        scope: 'global',
    },
    {
        id: 'app.export',
        keys: 'ctrl+e',
        label: 'Export',
        group: 'General',
        scope: 'global',
    },
    {
        id: 'app.closeCurrent',
        keys: 'ctrl+w',
        label: 'Close current tab',
        group: 'General',
        scope: 'global',
    },

    // ── Modal ────────────────────────────────────────────────────────────────
    {
        id: 'modal.close',
        keys: 'escape',
        label: 'Close modal',
        group: 'General',
        // `modal` scope replaces the old `if (activeModal) closeModal()` check —
        // the guard is now structural rather than a conditional in the handler.
        scope: 'modal',
        // Escape from a focused field inside a modal is the most guarded position
        // in the app and must still work.
        allowInTextEntry: true,
    },
] as const;

/** Union of the ids actually declared, so `useAction` can be checked at compile time. */
export type KnownActionId = (typeof SHORTCUTS)[number]['id'];
