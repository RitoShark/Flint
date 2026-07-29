import { useEffect, useRef } from 'react';
import { useNavigationStore } from '../stores/navigationStore';
import { useModalStore } from '../stores/modalStore';
import { installShortcuts, pushFocusScope, registerAction, type ActionHandler } from './registry';
import type { ScopeId } from './types';
import type { KnownActionId } from './manifest';

/**
 * Base scope stack: `global`, the current view, and `modal` on top when one is open.
 *
 * Read via getState() at event time rather than through a subscription, so the
 * listener never dispatches against a stale view.
 */
function getBaseScopeStack(): ScopeId[] {
    const stack: ScopeId[] = ['global', useNavigationStore.getState().currentView];
    if (useModalStore.getState().activeModal) stack.push('modal');
    return stack;
}

const host = { getBaseScopeStack };

/** Mount the global keydown listener. Call once, from App. */
export function useShortcutEngine(): void {
    useEffect(() => installShortcuts(host), []);
}

/**
 * Bind a handler to a manifest action.
 *
 * The handler is held in a ref, so callers don't need to memoise it — a fresh
 * closure each render is fine and always sees current props/state.
 */
export function useAction(id: KnownActionId, handler: ActionHandler): void {
    const ref = useRef(handler);
    ref.current = handler;

    useEffect(() => registerAction(id, (e) => ref.current(e)), [id]);
}

/**
 * Push a focus scope while `active`, popping it on unmount or when it goes false.
 *
 * Only focus scopes are pushed manually; view scopes are derived from
 * `currentView`, so they can't leak.
 */
export function useScope(scope: ScopeId, active = true): void {
    useEffect(() => {
        if (!active) return;
        return pushFocusScope(scope);
    }, [scope, active]);
}
