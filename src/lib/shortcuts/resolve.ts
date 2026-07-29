import { parseCombo, type Combo } from './combo';
import type { ActionId, ResolveContext, Shortcut } from './types';

/**
 * Combo → shortcuts index, memoised per manifest array.
 *
 * Without this, every keystroke would re-parse every `keys` string. Keyed by array
 * identity in a WeakMap so test fixtures and the real manifest each get their own
 * index and neither leaks.
 */
const indexCache = new WeakMap<Shortcut[], Map<Combo, Shortcut[]>>();

function indexManifest(manifest: Shortcut[]): Map<Combo, Shortcut[]> {
    const cached = indexCache.get(manifest);
    if (cached) return cached;

    const index = new Map<Combo, Shortcut[]>();
    for (const shortcut of manifest) {
        const combo = parseCombo(shortcut.keys);
        const bucket = index.get(combo);
        if (bucket) bucket.push(shortcut);
        else index.set(combo, [shortcut]);
    }

    indexCache.set(manifest, index);
    return index;
}

/**
 * Decide which action a keystroke triggers.
 *
 * Pure: the scope stack arrives as an argument rather than being read from module
 * state, so any (combo, scope-stack, typing) situation is directly testable without
 * a DOM or a store.
 *
 * Precedence is by position in the scope stack — the topmost scope that binds the
 * combo wins, which is what lets two views bind the same key to different actions.
 */
export function resolve(
    combo: Combo,
    manifest: Shortcut[],
    ctx: ResolveContext,
): ActionId | null {
    const candidates = indexManifest(manifest).get(combo);
    if (!candidates) return null;

    const modalOpen = ctx.scopeStack.includes('modal');

    let best: Shortcut | null = null;
    let bestRank = -1;

    for (const shortcut of candidates) {
        // Typing wins over shortcuts unless the shortcut explicitly opts out —
        // otherwise any unmodified binding would corrupt text entry.
        if (ctx.inTextEntry && !shortcut.allowInTextEntry) continue;

        // An open modal masks lower scopes, so Ctrl+N can't stack a second modal.
        if (modalOpen && shortcut.scope !== 'modal' && !shortcut.survivesModal) continue;

        const rank = ctx.scopeStack.lastIndexOf(shortcut.scope);
        if (rank < 0) continue;

        if (rank > bestRank) {
            best = shortcut;
            bestRank = rank;
        }
    }

    return best ? best.id : null;
}
