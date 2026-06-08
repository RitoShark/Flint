import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { SubmeshRange } from './meshBuilder';

/**
 * Map geometry is huge — a full Summoner's Rift mapgeo decodes to ~2M verts
 * across ~600 submeshes. Building one Babylon Mesh per submesh (as the SKN
 * path does) creates 600 meshes / 600 ComputeNormals passes / 600 GPU buffers,
 * which on this scale spikes memory into the multiple-GB range and freezes the
 * window.
 *
 * Submeshes that share a texture are visually identical material-wise, so we
 * MERGE them: one Babylon Mesh per unique texture path (~180 instead of 600).
 * Each merged mesh gets its own compact, re-based vertex pool so GPU upload
 * stays small and ComputeNormals runs ~180 times, not 600.
 *
 * Returns the meshes plus, for each, the texture path it needs (or null when
 * the submesh had no material entry — rendered as a solid colour by the caller).
 */
export interface MapGeometryInput {
    positions: Float32Array; // global pool, len = vertexCount*3
    uvs: Float32Array;       // global pool, len = vertexCount*2
    indices: Uint32Array;    // global indices
    submeshes: SubmeshRange[];
    /** submesh name -> diffuse texture path */
    materials: Record<string, string>;
}

/** One original submesh's triangle range inside a merged mesh, kept so a picked
 *  faceId resolves to the exact material under the cursor. */
export interface SubmeshSpan {
    name: string;               // original submesh / material name
    texturePath: string | null; // its diffuse texture bin path
    startFace: number;          // first triangle index within the merged mesh
    faceCount: number;          // number of triangles
    // Range into the GLOBAL index pool (data.indices) — for reading this
    // submesh's UVs/positions from the global arrays (used by the UV overlay).
    globalStartIndex: number;
    globalIndexCount: number;
}

export interface BuiltMapMesh {
    mesh: Mesh;
    /** Texture path this mesh needs, or null if the submesh had no material. */
    texturePath: string | null;
    /** MapModel.layer bitmask for this mesh (all merged submeshes share it). */
    layer: number;
    /** Variants this mesh participates in (derived from layer) — for the panel. */
    variants: MapVariant[];
    /** Location keys (material names minus element token) for the submeshes in
     *  this mesh. A default (0x01) piece and the elemental piece that replaces
     *  it at the same spot share a key, so activating the element hides the
     *  default counterpart. */
    replaceKeys: string[];
    /** Baron-pit stage if this mesh is part of the staged Baron geometry, else
     *  null. Used by an independent stage selector. */
    baronStage: BaronStage | null;
    /** Triangle spans of the submeshes merged into this mesh (for pick identity). */
    spans: SubmeshSpan[];
}

/** Detect an element token in a material name (Earth=Mountain, Fire=Infernal),
 *  ignoring the Earth_Order_* / Fire_Order_* leading-prefix jungle-terrain case.
 *  Returns the variant bit, or 0 if the name has no element token. */
function elementBitFromName(submeshName: string): number {
    const leaf = submeshName.toLowerCase().replace(/^.*\//, '');
    if (/[_/]ocean([_/]|$)/.test(leaf)) return VARIANT_BIT.Ocean;
    if (/[_/]infernal([_/]|$)/.test(leaf)) return VARIANT_BIT.Infernal;
    if (/[_/]mountain([_/]|$)/.test(leaf)) return VARIANT_BIT.Mountain;
    if (/[_/]cloud([_/]|$)/.test(leaf)) return VARIANT_BIT.Cloud;
    if (/[_/]hextech([_/]|$)/.test(leaf)) return VARIANT_BIT.Hextech;
    if (/[_/]chemtech([_/]|$)/.test(leaf)) return VARIANT_BIT.Chemtech;
    if (/[_/]fire([_/]|$)/.test(leaf) && !/^fire_/.test(leaf)) return VARIANT_BIT.Infernal;
    if (/[_/]earth([_/]|$)/.test(leaf) && !/^earth_/.test(leaf)) return VARIANT_BIT.Mountain;
    return 0;
}

/**
 * Effective layer for a mesh: the raw MapModel.layer, corrected for a data quirk
 * where some elemental pieces are mistagged 0xff ("shared") even though their
 * NAME says they belong to one element (e.g. DragonPit_Ocean_A is layer 0xff).
 * Left as 0xff they'd show in every theme and z-fight the active element's pit.
 * If a 0xff piece has an element token in its name, demote it to that element's
 * bit so it only shows under that theme.
 */
export function effectiveLayer(rawLayer: number, submeshName: string): number {
    if (rawLayer === SHARED_LAYER) {
        const bit = elementBitFromName(submeshName);
        if (bit !== 0) return bit; // mistagged-shared elemental piece -> its element
    }
    return rawLayer;
}

/** Strip the element token from a material name to get a location key shared by
 *  a default piece and its elemental replacement (DragonPit_A ~ DragonPit_Fire_A). */
export function replacementKey(submeshName: string): string {
    let s = submeshName.toLowerCase();
    s = s.replace(
        /[_/](ocean|mountain|earth|infernal|fire|cloud|hextech|chemtech|ruined)(?=[_/])/g,
        '',
    );
    s = s.replace(/\/(ocean|mountain|earth|infernal|fire|cloud|hextech|chemtech|ruined)\//g, '/');
    return s;
}

/** League elemental rift variants, plus "Base" for the static map. */
export const MAP_VARIANTS = [
    'Base',
    'Infernal',
    'Mountain',
    'Ocean',
    'Cloud',
    'Hextech',
    'Chemtech',
] as const;
export type MapVariant = (typeof MAP_VARIANTS)[number];

/**
 * AUTHORITATIVE variant encoding: MapModel.layer is a bitmask, one bit per
 * elemental rift. Verified against the real Map11 mapgeo by cross-referencing
 * each elemental dragon pit to its layer bit. 0xff = shared (all variants).
 */
export const VARIANT_BIT: Record<Exclude<MapVariant, 'Base'>, number> = {
    Infernal: 0x02,
    Mountain: 0x04,
    Ocean: 0x08,
    Cloud: 0x10,
    Hextech: 0x20,
    Chemtech: 0x40,
};
const BASE_BIT = 0x01;
const SHARED_LAYER = 0xff;

/**
 * Layer-only visibility (replacement handled separately in the renderer).
 *
 * Layer semantics, verified on Map11:
 *   0xff       = shared geometry, present in EVERY variant (always show).
 *   0x01       = "default" geometry: the base terrain AND the no-element version
 *                of swappable spots (default dragon pit, braziers). This is the
 *                full base map and must STAY VISIBLE under an elemental theme too
 *                (you only swap the few spots the element changes).
 *   0x02..0x40 = element-specific pieces (one bit per rift).
 *
 * So when element X is active we show: shared (0xff) + default (0x01) + X's
 * pieces. The default pieces that X *replaces* are then hidden by replacement
 * keys in the renderer — bit logic alone can't know which default spot a given
 * element piece overrides.
 */
export function layerVisibleForVariant(layer: number, active: MapVariant): boolean {
    if (layer === SHARED_LAYER) return true;
    if ((layer & BASE_BIT) !== 0) return true; // default geometry shows in all themes
    if (active === 'Base') return false; // pure-element piece, no theme active
    return (layer & VARIANT_BIT[active]) !== 0; // element piece for the active theme
}

/** Which variants does this layer byte participate in (for the present-variants
 *  list and per-mesh labels)? */
export function variantsForLayer(layer: number): MapVariant[] {
    if (layer === SHARED_LAYER) return ['Base']; // shared shows under every theme
    const out: MapVariant[] = [];
    if (layer & BASE_BIT) out.push('Base');
    for (const v of MAP_VARIANTS) {
        if (v === 'Base') continue;
        if (layer & VARIANT_BIT[v]) out.push(v);
    }
    return out;
}

/** Baron pit changes state through the game (Herald-era walled -> default ->
 *  post-Baron upgraded). These geometries overlap, so only one shows at a time,
 *  selected independently of the elemental theme. "Default" = the piece with no
 *  stage token. */
export const BARON_STAGES = ['Default', 'Walled', 'Upgraded'] as const;
export type BaronStage = (typeof BARON_STAGES)[number];

/** Detect the Baron stage of a material name, or null if it isn't a Baron-pit
 *  piece that has stages. */
export function classifyBaronStage(submeshName: string): BaronStage | null {
    const leaf = submeshName.toLowerCase().replace(/^.*\//, '');
    if (!/baron/.test(leaf)) return null;
    if (/[_/]walled([_/]|$)/.test(leaf)) return 'Walled';
    if (/[_/]upgraded([_/]|$)/.test(leaf)) return 'Upgraded';
    // Baron piece with no stage token = the default state. Exclude the tunnel
    // and the river (e.g. "BaronRiver"), which are present in all stages.
    if (/tunnel|river/.test(leaf)) return null;
    return 'Default';
}

/** Key used to group submeshes into one mesh: effective-layer + texture. Using
 *  the EFFECTIVE layer (0xff elemental-by-name corrected to its element bit)
 *  keeps each mesh's variant membership unambiguous. */
function groupKey(materials: Record<string, string>, sm: SubmeshRange): string {
    const tex = materials[sm.name] ?? `__notex__${sm.name}`;
    const layer = effectiveLayer(sm.layer ?? 0xff, sm.name);
    return `${layer}::${tex}`;
}

export function buildMapMeshes(input: MapGeometryInput, scene: Scene): BuiltMapMesh[] {
    const { positions, uvs, indices, submeshes, materials } = input;

    // Group submeshes by (layer, texture).
    const groups = new Map<string, SubmeshRange[]>();
    for (const sm of submeshes) {
        const key = groupKey(materials, sm);
        const list = groups.get(key);
        if (list) list.push(sm);
        else groups.set(key, [sm]);
    }

    const out: BuiltMapMesh[] = [];

    for (const [key, group] of groups) {
        // Total sizes for this group.
        let totalVerts = 0;
        let totalIdx = 0;
        for (const sm of group) {
            totalVerts += sm.vertex_count;
            totalIdx += sm.index_count;
        }

        const gPos = new Float32Array(totalVerts * 3);
        const gUv = new Float32Array(totalVerts * 2);
        const gIdx = new Uint32Array(totalIdx);

        let vWrite = 0; // vertex write cursor (in vertices)
        let iWrite = 0; // index write cursor
        const spans: SubmeshSpan[] = [];

        for (const sm of group) {
            const vStart = sm.start_vertex;
            const vCount = sm.vertex_count;
            const iStart = sm.start_index;
            const iCount = sm.index_count;
            // Span: this submesh's triangles occupy [iWrite/3, (iWrite+iCount)/3).
            spans.push({
                name: sm.name,
                texturePath: materials[sm.name] ?? null,
                startFace: iWrite / 3,
                faceCount: iCount / 3,
                globalStartIndex: iStart,
                globalIndexCount: iCount,
            });

            // Copy this submesh's vertices into the group pool.
            for (let i = 0; i < vCount * 3; i++) gPos[vWrite * 3 + i] = positions[vStart * 3 + i];
            // UVs with V flipped (matches RawTexture invertY=true downstream).
            for (let i = 0; i < vCount * 2; i++) {
                gUv[vWrite * 2 + i] =
                    i % 2 === 1 ? 1.0 - uvs[vStart * 2 + i] : uvs[vStart * 2 + i];
            }
            // Re-base indices: global -> this submesh's local range, then offset
            // by where the submesh landed in the group pool (vWrite).
            for (let i = 0; i < iCount; i++) {
                gIdx[iWrite + i] = indices[iStart + i] - vStart + vWrite;
            }

            vWrite += vCount;
            iWrite += iCount;
        }

        const normals = new Float32Array(totalVerts * 3);
        VertexData.ComputeNormals(gPos, gIdx, normals);

        const vd = new VertexData();
        vd.positions = gPos;
        vd.indices = gIdx;
        vd.normals = normals;
        vd.uvs = gUv;

        // key is "<layer>::<texturePath-or-__notex__name>".
        const sep = key.indexOf('::');
        const layer = parseInt(key.slice(0, sep), 10);
        const texPart = key.slice(sep + 2);
        const texturePath = texPart.startsWith('__notex__') ? null : texPart;

        const mesh = new Mesh(key, scene);
        vd.applyToMesh(mesh);
        mesh.sideOrientation = Mesh.DOUBLESIDE;

        const variants = variantsForLayer(layer);
        const replaceKeys = [...new Set(group.map(sm => replacementKey(sm.name)))];
        const baronStage =
            group.map(sm => classifyBaronStage(sm.name)).find(s => s !== null) ?? null;
        out.push({ mesh, texturePath, layer, variants, replaceKeys, baronStage, spans });
    }

    return out;
}

/** Resolve a picked faceId (triangle index in a merged mesh) to the submesh
 *  span it falls in, or null if out of range. */
export function resolveFace(built: BuiltMapMesh, faceId: number): SubmeshSpan | null {
    for (const s of built.spans) {
        if (faceId >= s.startFace && faceId < s.startFace + s.faceCount) return s;
    }
    return null;
}
