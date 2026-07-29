import { comboFromEvent } from './combo';
import { resolve } from './resolve';
import { SHORTCUTS } from './manifest';
import type { ActionId, ScopeId, Shortcut } from './types';

export type ActionHandler = (e: KeyboardEvent) => void;

/**
 * Runtime side of the shortcut engine: action handlers, the focus-scope stack, and
 * the single keydown listener. Everything that decides *what* a keystroke means
 * lives in resolve.ts; this module only gathers context and dispatches.
 */

// ── Action handlers ──────────────────────────────────────────────────────────

const handlers = new Map<ActionId, ActionHandler>();

/** Bind an implementation to a manifest action. Returns an unregister function. */
export function registerAction(id: ActionId, handler: ActionHandler): () => void {
    if (import.meta.env?.DEV && handlers.has(id)) {
        // Two live components claiming one action is a bug the manifest tests
        // can't see, since it's a runtime condition rather than a data one.
        console.warn(`[shortcuts] action "${id}" registered twice; the later handler wins`);
    }
    handlers.set(id, handler);
    return () => {
        if (handlers.get(id) === handler) handlers.delete(id);
    };
}

// ── Focus scopes ─────────────────────────────────────────────────────────────

/** Tokens rather than bare ids, so two components pushing the same scope can each
 *  pop only their own entry. Later pushes rank higher. */
type ScopeToken = { scope: ScopeId };
let focusScopes: ScopeToken[] = [];

export function pushFocusScope(scope: ScopeId): () => void {
    const token: ScopeToken = { scope };
    focusScopes.push(token);
    return () => {
        focusScopes = focusScopes.filter((t) => t !== token);
    };
}

export function getFocusScopes(): ScopeId[] {
    return focusScopes.map((t) => t.scope);
}

// ── Text-entry detection ─────────────────────────────────────────────────────

/**
 * Whether focus is somewhere that should swallow keystrokes.
 *
 * Promoted from FileTree.tsx:339, the only one of the three hand-rolled copies
 * that checked `.monaco-editor` — without which any unmodified binding would
 * corrupt editing in the bin editor.
 */
export function isTextEntry(el: Element | null): boolean {
    if (!el) return false;

    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.getAttribute('role') === 'textbox') return true;
    if (el.closest('.monaco-editor')) return true;

    return false;
}

// ── Listener lifecycle ───────────────────────────────────────────────────────

export interface ShortcutsHost {
    /** View + modal scopes, read fresh at event time. The registry appends focus scopes. */
    getBaseScopeStack: () => ScopeId[];
}

let installCount = 0;
let detach: (() => void) | null = null;

function buildScopeStack(host: ShortcutsHost): ScopeId[] {
    const base = host.getBaseScopeStack();
    const focus = getFocusScopes();
    // `modal` must stay topmost so it masks focus scopes too.
    const modalIndex = base.indexOf('modal');
    if (modalIndex === -1) return [...base, ...focus];
    return [...base.slice(0, modalIndex), ...focus, 'modal'];
}

function handleKeyDown(host: ShortcutsHost, e: KeyboardEvent): void {
    const combo = comboFromEvent(e);
    if (!combo) return;

    const actionId = resolve(combo, SHORTCUTS as Shortcut[], {
        scopeStack: buildScopeStack(host),
        inTextEntry: isTextEntry(document.activeElement),
    });
    if (!actionId) return;

    const handler = handlers.get(actionId);
    // A declared-but-unimplemented action must fall through to the browser rather
    // than silently eating the key — the old engine preventDefault'd on any match.
    if (!handler) return;

    e.preventDefault();
    handler(e);
}

/**
 * Install the global keydown listener. Idempotent and refcounted, so React's
 * StrictMode double-mount cannot end up with two listeners firing every handler
 * twice — the failure mode of the old `initShortcuts()`.
 */
export function installShortcuts(host: ShortcutsHost): () => void {
    installCount += 1;

    if (installCount === 1) {
        const listener = (e: KeyboardEvent) => handleKeyDown(host, e);
        document.addEventListener('keydown', listener);
        detach = () => document.removeEventListener('keydown', listener);
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        installCount -= 1;
        if (installCount === 0 && detach) {
            detach();
            detach = null;
        }
    };
}

/** Test/debug helper: what the engine currently believes is active. */
export function debugScopeState(host: ShortcutsHost): {
    scopeStack: ScopeId[];
    boundActions: ActionId[];
} {
    return { scopeStack: buildScopeStack(host), boundActions: [...handlers.keys()] };
}
