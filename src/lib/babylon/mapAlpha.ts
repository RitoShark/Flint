import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { MapMaterial } from '../api/mapPreview';

export function mapAlphaCutoff(material: MapMaterial | null | undefined): number {
    return material?.alpha_test ?? 0;
}

export function applyMapAlpha(mat: PBRMaterial, material: MapMaterial | null | undefined): void {
    const cutoff = mapAlphaCutoff(material);
    const blended = material?.translucent ?? false;
    mat.alphaCutOff = cutoff;
    mat.useAlphaFromAlbedoTexture = blended || cutoff > 0;
    mat.transparencyMode = blended
        ? (cutoff > 0 ? PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND : PBRMaterial.PBRMATERIAL_ALPHABLEND)
        : (cutoff > 0 ? PBRMaterial.PBRMATERIAL_ALPHATEST : PBRMaterial.PBRMATERIAL_OPAQUE);
    mat.forceDepthWrite = !blended;
}
