import { invokeCommand } from './core';

export async function extractAssetReferences(binData: Uint8Array): Promise<string[]> {
    return invokeCommand('extract_asset_references', { binData: Array.from(binData) });
}

export async function validateAssets(
    assetPaths: string[],
    wadPath: string
): Promise<{ valid: string[]; missing: string[] }> {
    return invokeCommand('validate_assets', { assetPaths, wadPath });
}
