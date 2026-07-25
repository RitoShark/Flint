/**
 * Shortcut vocabulary.
 *
 * `ScopeId` splits three ways:
 *  - view scopes, derived from `navigationStore.currentView` — never pushed by hand,
 *    so they cannot desync from the visible view;
 *  - focus scopes (`file-tree`, `model-preview`, `zoomable`), pushed by the component
 *    that owns the focused surface;
 *  - `modal`, derived from `modalStore.activeModal`, which masks lower scopes.
 */
export type ScopeId =
    // view scopes — mirror ViewType
    | 'global'
    | 'welcome'
    | 'preview'
    | 'extract'
    | 'wad-explorer'
    | 'file-editor'
    | 'archive-editor'
    | 'manifest'
    // focus scopes
    | 'file-tree'
    | 'model-preview'
    | 'zoomable'
    // state-derived, masking
    | 'modal';

export type ActionId = string;

export interface Shortcut {
    /** Stable action identifier, e.g. 'tab.next'. Handlers register against this. */
    id: ActionId;
    /** Authored combo. Any modifier order; normalised by parseCombo. */
    keys: string;
    /** Cheat-sheet label. Lives here so it cannot drift from `keys`. */
    label: string;
    /** Cheat-sheet section. */
    group: string;
    scope: ScopeId;
    /** Fire even when focus is in a text field. Default false. */
    allowInTextEntry?: boolean;
    /** Fire even when a modal is open. Default false. */
    survivesModal?: boolean;
}

export interface ResolveContext {
    /** Active scopes ordered bottom → top. `global` is first; topmost wins. */
    scopeStack: ScopeId[];
    /** Whether focus is currently in a text-entry surface. */
    inTextEntry: boolean;
}
