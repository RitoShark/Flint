import { invokeCommand } from './core';
import type { VfxSystem } from '../vfx/bindings';

export interface IdleAttachment {
    bone: string;
    position: [number, number, number];
    targetBone: string;
    system: VfxSystem;
}

export interface IdleEffectData {
    attachments: IdleAttachment[];
    warnings: string[];
}

export function readModelIdleEffects(sknPath: string): Promise<IdleEffectData> {
    return invokeCommand('read_model_idle_effects', { sknPath });
}
