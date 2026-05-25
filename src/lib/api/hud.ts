import { invokeCommand } from './core';

export interface HudData {
    type: string;
    version: number;
    linked: string[];
    entries: Record<string, HudEntry>;
}

export interface HudEntry {
    name: string;
    type: string;
    enabled: boolean;
    Layer: number;
    position?: HudPosition;
    TextureData?: TextureData;
    Scene?: string;
    extra?: Record<string, unknown>;
}

export interface HudPosition {
    UIRect: UiRect;
    Anchors?: Anchors;
}

export interface UiRect {
    position: Vec2;
    Size: Vec2;
    SourceResolutionWidth: number;
    SourceResolutionHeight: number;
}

export interface Vec2 {
    x: number;
    y: number;
}

export interface Anchors {
    Anchor: Vec2;
}

export interface TextureData {
    mTextureName: string;
    mTextureUV?: Vec4;
}

export interface Vec4 {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface HudFileStats {
    total_elements: number;
    by_type: Record<string, number>;
    by_layer: Record<number, number>;
}

export async function parseHudRitobinFile(filePath: string): Promise<HudData> {
    return invokeCommand('parse_hud_ritobin_file', { filePath });
}

export async function saveHudRitobinFile(
    filePath: string,
    data: HudData,
    originalContent: string
): Promise<void> {
    return invokeCommand('save_hud_ritobin_file', { filePath, data, originalContent });
}

export async function getHudFileStats(filePath: string): Promise<HudFileStats> {
    return invokeCommand('get_hud_file_stats', { filePath });
}
