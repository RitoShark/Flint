import { invokeCommand } from './core';

export interface JointWeight {
    index: number;
    /** Null when the weight list and skeleton lengths disagree. */
    name: string | null;
    parentIndex: number | null;
    weight: number;
}

export interface MaskView {
    key: number;
    joints: JointWeight[];
}

export interface MaskDocument {
    masks: MaskView[];
    /** Weights could not be paired to joints; names are withheld. */
    jointCountMismatch: boolean;
    skeletonJointCount: number;
}

export async function readAnimationMasks(
    binPath: string,
    sklPath: string,
): Promise<MaskDocument> {
    return invokeCommand<MaskDocument>('read_animation_masks', { binPath, sklPath });
}

/** Returns how many masks were written. */
export async function saveAnimationMasks(
    binPath: string,
    masks: MaskView[],
): Promise<number> {
    return invokeCommand<number>('save_animation_masks', { binPath, masks });
}
