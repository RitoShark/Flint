import { invokeCommand } from './core';
import type { EffectFields } from '../babylon/idleEffectValues';

export interface IdleAttachment {
    bone: string;
    position: [number, number, number];
    emitters: EffectFields[];
}

export interface IdleEffectData {
    attachments: IdleAttachment[];
    warnings: string[];
}

export function readModelIdleEffects(sknPath: string): Promise<IdleEffectData> {
    return invokeCommand('read_model_idle_effects', { sknPath });
}
