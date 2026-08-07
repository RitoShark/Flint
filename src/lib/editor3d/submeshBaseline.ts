/**
 * Submesh visibility baseline for the 3D editor: `initialSubmeshToHide` from the
 * skin BIN plus the active gear form's delta. Ported from `ModelPreview.tsx`'s
 * `effectiveInitialHide`/`usableForms` (see its Materials popup) so the editor
 * derives the exact same hidden set the preview shows for the same file.
 *
 * Kept as a plain, Babylon-free module (mirrors `submeshVisibility.ts`/
 * `cameraFraming.ts`) so both the editor viewport and its outliner can share
 * one implementation without either owning the other's state.
 */

import type { SkinForm } from '../api/mesh';
import { fnv1a32Lower } from '../babylon/submeshVisibility';

/**
 * Baseline hidden set (lowercased names): `initialHide` plus the active form's
 * `hide_hashes`/`show_hashes` delta (hide first, show wins). Forms are DELTAS
 * over the baseline, not full states — the base BIN already hides every form's
 * meshes at load, which is why gears don't hide each other.
 */
export function baselineHiddenLower(
    initialHide: string[] | undefined,
    forms: SkinForm[] | undefined,
    activeForm: number,
    submeshNames: string[],
): Set<string> {
    const hidden = new Set((initialHide ?? []).map((n) => n.toLowerCase()));
    const form = forms?.[activeForm];
    if (!form) return hidden;

    const lowerByHash = new Map<number, string>();
    for (const n of submeshNames) lowerByHash.set(fnv1a32Lower(n), n.toLowerCase());

    for (const h of form.hide_hashes) {
        const n = lowerByHash.get(h >>> 0);
        if (n) hidden.add(n);
    }
    for (const h of form.show_hashes) {
        const n = lowerByHash.get(h >>> 0);
        if (n) hidden.delete(n);
    }
    return hidden;
}

/**
 * Forms that actually change this mesh's baseline visibility. Filters both a
 * form that only touches another SKN's parts (dead button) and one that
 * mirrors the base look exactly — skins often list every form as a gear, so a
 * form identical to Base would be a redundant second button.
 */
export function usableForms(
    initialHide: string[] | undefined,
    forms: SkinForm[] | undefined,
    submeshNames: string[],
): { form: SkinForm; index: number }[] {
    if (!forms || forms.length === 0) return [];

    const lowerByHash = new Map<number, string>();
    for (const n of submeshNames) lowerByHash.set(fnv1a32Lower(n), n.toLowerCase());
    const baseHidden = new Set((initialHide ?? []).map((n) => n.toLowerCase()));

    return forms
        .map((form, index) => ({ form, index }))
        .filter(({ form }) =>
            form.hide_hashes.some((h) => {
                const n = lowerByHash.get(h >>> 0);
                return !!n && !baseHidden.has(n);
            }) ||
            form.show_hashes.some((h) => {
                const n = lowerByHash.get(h >>> 0);
                return !!n && baseHidden.has(n);
            }));
}

/** Exact-case names (from `submeshNames`) whose lowercased form is in `hiddenLower`. */
export function namesHiddenBy(hiddenLower: Set<string>, submeshNames: string[]): Set<string> {
    return new Set(submeshNames.filter((n) => hiddenLower.has(n.toLowerCase())));
}
