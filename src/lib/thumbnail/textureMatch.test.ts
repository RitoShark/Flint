import { describe, expect, it } from 'vitest';
import { isTextureFile, matchTexturesToMeshes, normalizeName } from './textureMatch';

const files = (...names: string[]) => names.map(n => ({ fileName: n, path: `C:/tex/${n}` }));

describe('normalizeName', () => {
    it('drops the extension and the babylon mesh prefix', () => {
        expect(normalizeName('mesh_Body')).toBe('body');
        expect(normalizeName('Kayn_Base_Body.dds')).toBe('kayn_base_body');
        expect(normalizeName('Cape.TEX')).toBe('cape');
    });
});

describe('isTextureFile', () => {
    it('accepts the formats an artist would pick and nothing else', () => {
        expect(isTextureFile('a.dds')).toBe(true);
        expect(isTextureFile('a.tex')).toBe(true);
        expect(isTextureFile('a.png')).toBe(true);
        expect(isTextureFile('a.jpeg')).toBe(true);
        expect(isTextureFile('a.skn')).toBe(false);
        expect(isTextureFile('a.dds.bak')).toBe(false);
    });
});

describe('matchTexturesToMeshes', () => {
    it('prefers an exact stem over a suffix hit', () => {
        const out = matchTexturesToMeshes(
            ['mesh_Body'],
            files('Kayn_Base_Body.dds', 'body.dds'),
        );
        expect(out).toEqual({ mesh_Body: 'C:/tex/body.dds' });
    });

    it('matches the league naming where the file carries the skin prefix', () => {
        const out = matchTexturesToMeshes(
            ['mesh_Body', 'mesh_Cape'],
            files('Kayn_Base_Body.dds', 'Kayn_Base_Cape.tex'),
        );
        expect(out).toEqual({
            mesh_Body: 'C:/tex/Kayn_Base_Body.dds',
            mesh_Cape: 'C:/tex/Kayn_Base_Cape.tex',
        });
    });

    it('takes the longest shared run when several files could apply', () => {
        const out = matchTexturesToMeshes(
            ['mesh_Base_Body'],
            files('body.dds', 'base_body.dds'),
        );
        expect(out).toEqual({ mesh_Base_Body: 'C:/tex/base_body.dds' });
    });

    it('leaves a submesh alone when the folder has nothing for it', () => {
        const out = matchTexturesToMeshes(['mesh_Body', 'mesh_Weapon'], files('body.png'));
        expect(out).toEqual({ mesh_Body: 'C:/tex/body.png' });
    });

    it('ignores non-texture files in the folder', () => {
        expect(matchTexturesToMeshes(['mesh_Body'], files('body.skn', 'body.anm'))).toEqual({});
    });

    it('returns nothing for an empty folder', () => {
        expect(matchTexturesToMeshes(['mesh_Body'], [])).toEqual({});
    });
});
