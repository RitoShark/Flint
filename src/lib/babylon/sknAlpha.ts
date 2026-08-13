/**
 * Alpha policy for League SKN materials.
 *
 * League charskin textures carry cutout alpha: hair cards, cape edges, and the
 * eye / eyelash overlay quads. Rendering those OPAQUE fills the cut-away pixels
 * with whatever the texture happened to store there — which is why the Thumbnail
 * Creator drew solid blocks over the eyes while the model preview drew them
 * correctly. The preview read the decoder's `has_alpha` flag; the thumbnail
 * scene hardcoded "no alpha" and threw the same flag away.
 *
 * The decision now lives here so the two renderers cannot drift apart again.
 * The values mirror what `ModelPreview.tsx` has always applied inline: alpha
 * test AND blend, so a hard cutoff kills the fully-transparent pixels while
 * feathered edges still blend; plus a depth pre-pass so overlapping alpha parts
 * do not sort each other into black silhouettes.
 *
 * Kept free of Babylon types (plain numbers/booleans) so it unit-tests in the
 * node environment vitest runs in — the same convention `cameraFraming.ts`
 * follows. The mode values mirror `Material.MATERIAL_*` exactly.
 */

/** Mirrors `Material.MATERIAL_OPAQUE`. */
export const MATERIAL_OPAQUE = 0;
/** Mirrors `Material.MATERIAL_ALPHATESTANDBLEND`. */
export const MATERIAL_ALPHATESTANDBLEND = 3;

/** Alpha below this is cut entirely; above it blends. Tuned for the League
 *  charskin look and matched to the reference viewer. */
export const SKN_ALPHA_CUTOFF = 0.2;

export interface SknAlphaPolicy {
    /** Assign to `material.transparencyMode`. */
    transparencyMode: number;
    /** Assign to `material.useAlphaFromAlbedoTexture`. */
    useAlphaFromAlbedoTexture: boolean;
    /** Assign to `material.alphaCutOff`. */
    alphaCutOff: number;
    /** Assign to `material.needDepthPrePass`. */
    needDepthPrePass: boolean;
}

/**
 * Material alpha settings for a SKN texture, given the decoder's `has_alpha`
 * (any pixel with alpha < 255). An absent flag is treated as opaque, matching
 * the embedded-texture fallback path where alpha is never reported.
 */
export function sknAlphaPolicy(hasAlpha: boolean | undefined): SknAlphaPolicy {
    if (!hasAlpha) {
        return {
            transparencyMode: MATERIAL_OPAQUE,
            useAlphaFromAlbedoTexture: false,
            alphaCutOff: SKN_ALPHA_CUTOFF,
            needDepthPrePass: false,
        };
    }
    return {
        transparencyMode: MATERIAL_ALPHATESTANDBLEND,
        useAlphaFromAlbedoTexture: true,
        alphaCutOff: SKN_ALPHA_CUTOFF,
        needDepthPrePass: true,
    };
}
