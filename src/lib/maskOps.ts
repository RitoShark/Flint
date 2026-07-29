import type { JointWeight } from './api/animask';

/**
 * `index` plus every joint transitively parented under it, found by walking
 * `parentIndex` downward from `index`.
 *
 * Uses an explicit visited set — the same defense `jointDepth` in
 * `MaskEditor.tsx` uses for its (upward) walk — so a cyclic `parentIndex` in
 * a corrupt BIN makes this return early instead of looping forever. Without
 * it, a joint whose descendants loop back on themselves (or on `index`)
 * would bounce between them forever: nothing in the walk would ever
 * naturally run out of children to push.
 */
export function descendantsOf(joints: JointWeight[], index: number): number[] {
    const childrenOf = new Map<number, number[]>();
    for (const j of joints) {
        if (j.parentIndex === null) continue;
        const siblings = childrenOf.get(j.parentIndex);
        if (siblings) siblings.push(j.index);
        else childrenOf.set(j.parentIndex, [j.index]);
    }

    const visited = new Set<number>();
    const stack = [index];
    const result: number[] = [];
    while (stack.length > 0) {
        const current = stack.pop() as number;
        if (visited.has(current)) continue;
        visited.add(current);
        result.push(current);
        const children = childrenOf.get(current);
        if (children) stack.push(...children);
    }
    return result;
}

/** Sets `weight` on `index` and every descendant; every other joint is untouched. */
export function setSubtree(joints: JointWeight[], index: number, weight: number): JointWeight[] {
    const targets = new Set(descendantsOf(joints, index));
    return joints.map((j) => (targets.has(j.index) ? { ...j, weight } : j));
}

/** Sets `weight` on every joint. */
export function setAll(joints: JointWeight[], weight: number): JointWeight[] {
    return joints.map((j) => ({ ...j, weight }));
}

/** Maps every joint's weight `w` to `1 - w`. */
export function invertAll(joints: JointWeight[]): JointWeight[] {
    return joints.map((j) => ({ ...j, weight: 1 - j.weight }));
}
