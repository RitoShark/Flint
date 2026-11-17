import { shaderForgeAvailable } from '@shaderforge';
import { invokeCommand } from './api/core';

export interface ShaderPreviewStatus {
    available: boolean;
    reason: string;
}

let availability: Promise<ShaderPreviewStatus> | undefined;

export function shaderPreviewStatus(): Promise<ShaderPreviewStatus> {
    if (!shaderForgeAvailable) return Promise.resolve({ available: false, reason: 'ShaderForge frontend is not included in this build.' });
    return availability ??= invokeCommand<boolean>('shader_preview_available', {}, { silent: true })
        .then(available => ({ available, reason: available ? 'ShaderForge connected. Loads materials for this SKN.' : 'This build has no ShaderForge backend. Start the shader-enabled build to use game shaders.' }))
        .catch(error => {
            availability = undefined;
            return { available: false, reason: `ShaderForge connection failed: ${String(error)}` };
        });
}

export async function shaderPreviewAvailable(): Promise<boolean> {
    return (await shaderPreviewStatus()).available;
}
