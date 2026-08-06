import type { BoneData } from '../babylon/skeletonBuilder';

export interface BoneNode {
    bone: BoneData;
    children: BoneNode[];
}

/**
 * Fold a flat SKL joint list into a hierarchy. `parent_id === -1` marks a root.
 *
 * Two defensive cases matter on real files: a joint whose `parent_id` names a
 * joint that is not in the list (repathed/hand-built skeletons) is promoted to
 * a root rather than dropped, and a self-parented joint is treated as a root so
 * the walk cannot loop.
 */
export function buildBoneTree(bones: BoneData[]): BoneNode[] {
    const nodes = new Map<number, BoneNode>();
    for (const bone of bones) {
        nodes.set(bone.id, { bone, children: [] });
    }

    const roots: BoneNode[] = [];
    for (const bone of bones) {
        const node = nodes.get(bone.id)!;
        const parent = bone.parent_id === bone.id ? undefined : nodes.get(bone.parent_id);
        if (parent) {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }
    return roots;
}
