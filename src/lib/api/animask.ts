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

/**
 * Read the masks in `binPath`, paired with joint names from `sklPath`.
 *
 * `sklPath` is optional: when omitted, the backend resolves the skeleton from
 * the BIN itself (its sibling skin BIN's `skeleton` field). Omitting it is
 * also how callers cheaply check "does this BIN have masks?" — resolution is
 * skipped server-side whenever the BIN has no mask map at all.
 */
export async function readAnimationMasks(
    binPath: string,
    sklPath?: string,
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

/**
 * Cheap presence probe: does this BIN have an animation mask map at all?
 * Does not resolve or parse a skeleton, so it's safe to call for any BIN.
 */
export async function binHasAnimationMasks(binPath: string): Promise<boolean> {
    return invokeCommand<boolean>('bin_has_animation_masks', { binPath });
}
