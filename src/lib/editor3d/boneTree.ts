import type { BoneData } from '../babylon/skeletonBuilder';

export interface BoneNode {
    bone: BoneData;
    children: BoneNode[];
}

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
