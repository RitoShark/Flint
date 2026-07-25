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

    // ── Tabs ─────────────────────────────────────────────────────────────────
    // TitleBar runs six tab families in one strip with no keyboard reach at all;
    // these are the browser-equivalent bindings over the flattened order.
    {
        id: 'tab.next',
        keys: 'ctrl+tab',
        label: 'Next tab',
        group: 'Tabs',
        scope: 'global',
    },
    {
        id: 'tab.prev',
        keys: 'ctrl+shift+tab',
        label: 'Previous tab',
        group: 'Tabs',
        scope: 'global',
    },
    { id: 'tab.slot1', keys: 'ctrl+1', label: 'Jump to tab 1', group: 'Tabs', scope: 'global' },
    { id: 'tab.slot2', keys: 'ctrl+2', label: 'Jump to tab 2', group: 'Tabs', scope: 'global' },
    { id: 'tab.slot3', keys: 'ctrl+3', label: 'Jump to tab 3', group: 'Tabs', scope: 'global' },
    { id: 'tab.slot4', keys: 'ctrl+4', label: 'Jump to tab 4', group: 'Tabs', scope: 'global' },
    { id: 'tab.slot5', keys: 'ctrl+5', label: 'Jump to tab 5', group: 'Tabs', scope: 'global' },
    { id: 'tab.slot6', keys: 'ctrl+6', label: 'Jump to tab 6', group: 'Tabs', scope: 'global' },
    { id: 'tab.slot7', keys: 'ctrl+7', label: 'Jump to tab 7', group: 'Tabs', scope: 'global' },
    { id: 'tab.slot8', keys: 'ctrl+8', label: 'Jump to tab 8', group: 'Tabs', scope: 'global' },
    {
        id: 'tab.last',
        keys: 'ctrl+9',
        // Slot 9 is "last tab" regardless of count, per browser/editor convention.
        label: 'Jump to last tab',
        group: 'Tabs',
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
