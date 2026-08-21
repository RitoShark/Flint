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

    // ── File tree ────────────────────────────────────────────────────────────
    // All in the 'file-tree' focus scope: unmodified keys like ArrowDown and
    // Delete must not fire while the 3D preview or an editor has focus.
    { id: 'tree.moveDown', keys: 'arrowdown', label: 'Move down', group: 'File tree', scope: 'file-tree' },
    { id: 'tree.moveUp', keys: 'arrowup', label: 'Move up', group: 'File tree', scope: 'file-tree' },
    { id: 'tree.expand', keys: 'arrowright', label: 'Expand folder / step in', group: 'File tree', scope: 'file-tree' },
    { id: 'tree.collapse', keys: 'arrowleft', label: 'Collapse folder / step out', group: 'File tree', scope: 'file-tree' },
    {
        id: 'tree.extendDown',
        keys: 'shift+arrowdown',
        label: 'Extend selection down',
        group: 'File tree',
        scope: 'file-tree',
    },
    {
        id: 'tree.extendUp',
        keys: 'shift+arrowup',
        label: 'Extend selection up',
        group: 'File tree',
        scope: 'file-tree',
    },
    { id: 'tree.first', keys: 'home', label: 'First item', group: 'File tree', scope: 'file-tree' },
    { id: 'tree.last', keys: 'end', label: 'Last item', group: 'File tree', scope: 'file-tree' },
    { id: 'tree.selectAll', keys: 'ctrl+a', label: 'Select all', group: 'File tree', scope: 'file-tree' },
    { id: 'tree.open', keys: 'enter', label: 'Open / toggle folder', group: 'File tree', scope: 'file-tree' },
    { id: 'tree.copyPath', keys: 'ctrl+c', label: 'Copy path', group: 'File tree', scope: 'file-tree' },
    // Migrated from FileTree's own window listener.
    { id: 'tree.rename', keys: 'f2', label: 'Rename', group: 'File tree', scope: 'file-tree' },
    { id: 'tree.delete', keys: 'delete', label: 'Delete', group: 'File tree', scope: 'file-tree' },

    // ── WAD Explorer ─────────────────────────────────────────────────────────
    // Migrated from WadExplorer's own window listener, which fired in addition to
    // the old registry because the two listened on different targets.
    {
        id: 'wadExplorer.focusSearch',
        keys: 'ctrl+f',
        label: 'Focus search',
        group: 'WAD Explorer',
        scope: 'wad-explorer',
        // Re-focusing the search box while already typing in it is legitimate.
        allowInTextEntry: true,
    },
    {
        id: 'wadExplorer.clearSearch',
        keys: 'escape',
        label: 'Clear search',
        group: 'WAD Explorer',
        scope: 'wad-explorer',
        allowInTextEntry: true,
    },

    // The list navigation sits in its own focus scope, pushed only while the WAD
    // list holds focus — bare arrows in the view scope would also fire over the
    // chunk preview and the search box.
    { id: 'wadTree.moveDown', keys: 'arrowdown', label: 'Move down', group: 'WAD Explorer', scope: 'wad-tree' },
    { id: 'wadTree.moveUp', keys: 'arrowup', label: 'Move up', group: 'WAD Explorer', scope: 'wad-tree' },
    { id: 'wadTree.expand', keys: 'arrowright', label: 'Expand / step in', group: 'WAD Explorer', scope: 'wad-tree' },
    { id: 'wadTree.collapse', keys: 'arrowleft', label: 'Collapse / step out', group: 'WAD Explorer', scope: 'wad-tree' },
    { id: 'wadTree.first', keys: 'home', label: 'First row', group: 'WAD Explorer', scope: 'wad-tree' },
    { id: 'wadTree.last', keys: 'end', label: 'Last row', group: 'WAD Explorer', scope: 'wad-tree' },
    { id: 'wadTree.open', keys: 'enter', label: 'Preview file / toggle row', group: 'WAD Explorer', scope: 'wad-tree' },

    // ── 3D preview ───────────────────────────────────────────────────────────
    // Orbit / wheel-zoom / pan still come from Babylon's own attachControl; these
    // only add what the camera could not previously do at all.
    {
        id: 'view.frameCamera',
        keys: 'f',
        label: 'Frame model',
        group: '3D preview',
        scope: 'model-preview',
    },
    {
        id: 'view.zoomIn',
        keys: 'ctrl+=',
        label: 'Zoom in',
        group: '3D preview',
        scope: 'model-preview',
    },
    {
        id: 'view.zoomOut',
        keys: 'ctrl+-',
        label: 'Zoom out',
        group: '3D preview',
        scope: 'model-preview',
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

    // ── Help ─────────────────────────────────────────────────────────────────
    {
        id: 'help.cheatSheet',
        keys: 'f1',
        label: 'Show keyboard shortcuts',
        group: 'Help',
        scope: 'global',
        // Reachable even with a dialog open — that's often exactly when you want it.
        survivesModal: true,
    },
    {
        id: 'help.closeCheatSheet',
        keys: 'escape',
        label: 'Close shortcuts',
        group: 'Help',
        // Declared in its own focus scope, pushed only while the sheet is open, so
        // it doesn't compete with modal.close the rest of the time.
        scope: 'cheat-sheet',
        allowInTextEntry: true,
        survivesModal: true,
    },
] as const;

/** Union of the ids actually declared, so `useAction` can be checked at compile time. */
export type KnownActionId = (typeof SHORTCUTS)[number]['id'];
