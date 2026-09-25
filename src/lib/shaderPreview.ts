import { shaderForgeAvailable } from '@shaderforge';
import { invokeCommand } from './api/core';

let availability: Promise<boolean> | undefined;

export function shaderPreviewAvailable(): Promise<boolean> {
    if (!shaderForgeAvailable) return Promise.resolve(false);
    return availability ??= invokeCommand<boolean>('shader_preview_available', {}, { silent: true })
        .catch(() => { availability = undefined; return false; });
}
