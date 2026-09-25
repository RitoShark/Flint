import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
export { Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
export type Texture = BaseTexture | TextureData;
export type Color = {
    r: number;
    g: number;
    b: number;
};
export type Blending = number;
export type BlendingDstFactor = number;
export type BlendingSrcFactor = number;
export type BlendingEquation = number;
export type Side = number;
export const ZeroFactor = 0, OneFactor = 1, SrcColorFactor = 768, OneMinusSrcColorFactor = 769, SrcAlphaFactor = 770, OneMinusSrcAlphaFactor = 771, DstAlphaFactor = 772, OneMinusDstAlphaFactor = 773, DstColorFactor = 774, OneMinusDstColorFactor = 775;
export const AddEquation = 32774, MinEquation = 32775, MaxEquation = 32776;
export const NoBlending = 0, CustomBlending = 1, FrontSide = 0, BackSide = 1, DoubleSide = 2;
export const DynamicDrawUsage = 1, FloatType = 1, RGBAFormat = 5;
export class AttributeData {
    version = 0;
    updateRanges: {
        start: number;
        count: number;
    }[] = [];
    instanced = false;
    constructor(public array: Float32Array | Uint32Array | Uint16Array | Uint8Array, public itemSize: number) { }
    get count() { return this.array.length / this.itemSize; }
    set needsUpdate(value: boolean) { if (value)
        this.version++; }
    setUsage(_usage: number) { return this; }
    clearUpdateRanges() { this.updateRanges.length = 0; }
    addUpdateRange(start: number, count: number) { this.updateRanges.push({ start, count }); }
    setX(i: number, x: number) { this.array[i * this.itemSize] = x; }
    setXYZ(i: number, x: number, y: number, z: number) { this.array.set([x, y, z], i * this.itemSize); }
    setXYZW(i: number, x: number, y: number, z: number, w: number) { this.array.set([x, y, z, w], i * this.itemSize); }
    getX(i: number) { return this.array[i * this.itemSize]; }
    getY(i: number) { return this.array[i * this.itemSize + 1]; }
    getZ(i: number) { return this.array[i * this.itemSize + 2]; }
}
export class InstanceAttribute extends AttributeData {
    override instanced = true;
}
export class GeometryData {
    attributes: Record<string, AttributeData> = {};
    index = new AttributeData(new Uint32Array(), 1);
    drawRange = { start: 0, count: Infinity };
    instanceCount = 1;
    setAttribute(name: string, data: AttributeData) { this.attributes[name] = data; return this; }
    getAttribute(name: string) { return this.attributes[name]; }
    setIndex(data: AttributeData | number[] | Uint32Array) { this.index = data instanceof AttributeData ? data : new AttributeData(Uint32Array.from(data), 1); return this; }
    getIndex() { return this.index; }
    setDrawRange(start: number, count: number) { this.drawRange = { start, count }; }
    computeBoundingSphere() { }
    computeVertexNormals() { const p = this.attributes.position.array; const normals = new Float32Array(p.length); VertexData.ComputeNormals(p, this.index.array, normals); this.setAttribute('normal', new AttributeData(normals, 3)); }
    dispose() { }
}
export class InstanceGeometry extends GeometryData {
}
export class TextureData {
    needsUpdate = true;
    constructor(public data: Float32Array | Uint8Array, public width: number, public height: number, public format = RGBAFormat, public type = FloatType) { }
    get image() { return { data: this.data, width: this.width, height: this.height }; }
    dispose() { }
}
export { TextureData as DataTexture };
export class MaterialSpec {
    vertexShader = '';
    fragmentShader = '';
    uniforms: Record<string, {
        value: any;
    }> = {};
    defines: Record<string, string | number> = {};
    side = DoubleSide;
    depthTest = true;
    depthWrite = false;
    transparent = true;
    blending = CustomBlending;
    blendSrc = SrcAlphaFactor;
    blendDst = OneMinusSrcAlphaFactor;
    blendEquation = AddEquation;
    blendSrcAlpha: number | null = null;
    blendDstAlpha: number | null = null;
    polygonOffset = false;
    polygonOffsetFactor = 0;
    polygonOffsetUnits = 0;
    wireframe = false;
    constructor(options: Partial<MaterialSpec>) { Object.assign(this, options); }
    dispose() { }
}
