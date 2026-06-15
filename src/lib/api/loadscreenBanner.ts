import { invokeCommand, invokeRaw } from './core';

export interface LoadscreenBannerInfo {
    loadscreen_image_path: string;
    loadscreen_exists: boolean;
    mask_path: string;
    mask_exists: boolean;
    material_name: string;
    applied: boolean;
}

/** Tunable shader params exposed as editor sliders. All optional — omitted
 *  fields fall back to the preset defaults on the backend. */
export interface BannerParams {
    shineStrength?: number;
    shineFrequency?: number;
    shineSpeed?: number;
    scrollSpeedX?: number;
    scrollSpeedY?: number;
    tint?: [number, number, number];
    glowPulse?: number;
}

export interface ApplyBannerResult {
    mask_path: string;
    width: number;
    height: number;
}

export async function getLoadscreenBannerInfo(projectPath: string): Promise<LoadscreenBannerInfo> {
    return invokeCommand('get_loadscreen_banner_info', { projectPath });
}

/**
 * Inject the StaticMaterialDef + link and build the mask .tex.
 * `rebuildMask` (default true) regenerates the mask's R/G scroll pattern while
 * keeping any existing painted blue — pass false for a params-only save so the
 * mask the user is actively painting isn't touched.
 */
export async function applyLoadscreenBanner(
    projectPath: string,
    params?: BannerParams,
    rebuildMask = true,
): Promise<ApplyBannerResult> {
    return invokeCommand('apply_loadscreen_banner', { projectPath, params: params ?? null, rebuildMask });
}

export async function saveBannerMask(
    maskPath: string,
    rgba: Uint8Array,
    width: number,
    height: number,
): Promise<void> {
    return invokeRaw('save_banner_mask', rgba, {
        path: maskPath,
        width: String(width),
        height: String(height),
    });
}
