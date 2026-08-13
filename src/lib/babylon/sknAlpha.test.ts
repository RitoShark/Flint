import { describe, it, expect } from 'vitest';
import {
    sknAlphaPolicy,
    MATERIAL_OPAQUE,
    MATERIAL_ALPHATESTANDBLEND,
    SKN_ALPHA_CUTOFF,
} from './sknAlpha';

describe('sknAlphaPolicy', () => {
    it('keeps textures without alpha fully opaque', () => {
        const p = sknAlphaPolicy(false);
        expect(p.transparencyMode).toBe(MATERIAL_OPAQUE);
        expect(p.useAlphaFromAlbedoTexture).toBe(false);
        expect(p.needDepthPrePass).toBe(false);
    });

    it('uses cutoff + blend for textures with alpha, so eye/hair cutouts survive', () => {
        const p = sknAlphaPolicy(true);
        expect(p.transparencyMode).toBe(MATERIAL_ALPHATESTANDBLEND);
        expect(p.useAlphaFromAlbedoTexture).toBe(true);
        expect(p.alphaCutOff).toBe(SKN_ALPHA_CUTOFF);
    });

    it('writes a depth pre-pass on alpha materials so overlapping parts do not sort to black', () => {
        expect(sknAlphaPolicy(true).needDepthPrePass).toBe(true);
    });

    it('treats a missing has_alpha flag as opaque', () => {
        expect(sknAlphaPolicy(undefined).transparencyMode).toBe(MATERIAL_OPAQUE);
    });
});
