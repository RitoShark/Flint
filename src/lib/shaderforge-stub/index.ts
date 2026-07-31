/**
 * Stub for the private shader-preview module. When the private overlay is
 * present (private/shaderforge), the `@shaderforge` alias resolves to the
 * real `ts/index.ts` instead and this file is not part of the build.
 *
 * Contract (keep in lockstep with the overlay's index):
 *  - `shaderForgeAvailable` — feature flag the preview UI gates on.
 *  - `loadShaderForge()` — resolves the API namespaces, or null here.
 */
export const shaderForgeAvailable = false;

export type ShaderForgeApi = never;

export async function loadShaderForge(): Promise<ShaderForgeApi | null> {
    return null;
}
