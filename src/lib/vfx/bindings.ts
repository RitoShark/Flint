export interface AssetRef {
    kind: 'file';
    path: string;
}

export interface NamedAsset {
    path: string;
    asset: AssetRef | null;
}

export interface VfxObject {
    entry: string;
    name: string | null;
}

export interface VfxField {
    hash: string;
    name: string | null;
    value: VfxValue;
}

export type VfxValue =
    | { type: 'none' | 'null' }
    | { type: 'bool'; value: boolean }
    | { type: 'number'; value: number }
    | { type: 'string'; value: string }
    | { type: 'vector'; values: number[] }
    | { type: 'matrix'; values: number[] | number[][] }
    | { type: 'hash' | 'link'; hash: string; name: string | null }
    | ({ type: 'asset' } & NamedAsset)
    | { type: 'struct'; classHash: string; class: string | null; object: VfxObject | null; fields: VfxField[] }
    | { type: 'container'; items: VfxValue[] }
    | { type: 'map'; entries: { key: string; value: VfxValue }[] };

export interface VfxSystem extends VfxObject {
    classHash: string;
    class: string | null;
    root: VfxValue;
    materials: MaterialPreview[];
}

export type Wrap = 'repeat' | 'clamp' | 'mirror' | 'border';
export type BlendFactor = 'zero' | 'one' | 'srcColor' | 'dstColor' | 'srcAlpha'
    | 'oneMinusSrcColor' | 'oneMinusDstColor' | 'oneMinusSrcAlpha';

export interface RenderState {
    blending: 'opaque' | 'normal' | 'additive' | 'modulate';
    srcFactor: BlendFactor;
    dstFactor: BlendFactor;
    depthTest: boolean;
    depthWrite: boolean;
    doubleSided: boolean;
    inverted: boolean;
    premultiplied: boolean;
    cutout: boolean;
}

export interface BaseTexture {
    name: string;
    texture: NamedAsset;
    wrap: [Wrap, Wrap];
    rule: 'exact' | 'switchOverride' | 'colorMapOverPlaceholder' | 'exactPlaceholder'
        | 'nameLike' | 'colorMapPath' | 'colorMapPathAnyName';
}

export interface MaterialPreview {
    hash: string;
    name: string | null;
    shader: string | null;
    missing: boolean;
    animated: boolean;
    base: BaseTexture | null;
    tint: [number, number, number] | null;
    opacity: number | null;
    alphaTest: number | null;
    uvRepeat: [number, number] | null;
    uvScroll: [number, number] | null;
    renderState: RenderState;
    warnings: { kind: 'noShaderDefs' | 'noPass' | 'secondPass' }[];
}
