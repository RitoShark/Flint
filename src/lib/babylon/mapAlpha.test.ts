import { afterEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { MapMaterial } from '../api/mapPreview';
import { applyMapAlpha, mapAlphaCutoff } from './mapAlpha';
import { buildMapMeshes } from './mapMeshBuilder';

const definition = (alpha_test: number | null, translucent = false): MapMaterial => ({
    path: 'foliage.tex', address_u: 0, address_v: 0, tint_color: null, alpha_test, translucent,
});

describe('map material alpha', () => {
    let engine: NullEngine | undefined;
    afterEach(() => engine?.dispose());
    const material = () => {
        engine = new NullEngine();
        const mat = new PBRMaterial('map', new Scene(engine));
        mat.unlit = true;
        return mat;
    };

    it('uses authored cutouts without blending or disabling depth writes', () => {
        const mat = material();
        applyMapAlpha(mat, definition(0.3));
        expect(mat.needAlphaTesting()).toBe(true);
        expect(mat.needAlphaBlending()).toBe(false);
        expect(mat.alphaCutOff).toBe(0.3);
        expect(mat.forceDepthWrite).toBe(true);
    });

    it('leaves materials without alpha tests opaque and resets previous state', () => {
        const mat = material();
        applyMapAlpha(mat, definition(0.5, true));
        applyMapAlpha(mat, definition(null));
        expect(mat.needAlphaTesting()).toBe(false);
        expect(mat.needAlphaBlending()).toBe(false);
        expect(mat.useAlphaFromAlbedoTexture).toBe(false);
        expect(mapAlphaCutoff(null)).toBe(0);
        expect(mapAlphaCutoff(definition(0))).toBe(0);
    });

    it('keeps explicit blending and an optional authored cutoff', () => {
        const mat = material();
        for (const cutoff of [null, 0.5]) {
            applyMapAlpha(mat, definition(cutoff, true));
            expect(mat.needAlphaBlending()).toBe(true);
            expect(mat.needAlphaTesting()).toBe(cutoff !== null);
            expect(mat.forceDepthWrite).toBe(false);
        }
    });

    it('keeps different alpha states separate when meshes share a texture', () => {
        engine = new NullEngine();
        const scene = new Scene(engine);
        const materials = {
            opaque: definition(null), cutout: definition(0.5), blended: definition(null, true), sameCutout: definition(0.5),
        };
        const meshes = buildMapMeshes({
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1]), uvs2: new Float32Array(6),
            indices: new Uint32Array([0, 1, 2]), materials,
            submeshes: Object.keys(materials).map(name => ({ name, start_vertex: 0, vertex_count: 3, start_index: 0, index_count: 3 })),
        }, scene);
        expect(meshes).toHaveLength(3);
        expect(meshes.find(m => m.material?.alpha_test === 0.5)?.spans.map(s => s.name)).toEqual(['cutout', 'sameCutout']);
        expect(meshes.filter(m => m.material?.translucent)).toHaveLength(1);
    });
});
