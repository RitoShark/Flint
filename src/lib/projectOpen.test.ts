import { describe, it, expect } from 'vitest';
import { parseSkinBinPath } from './projectOpen';

describe('parseSkinBinPath', () => {
    it('reads champion and skin from a skin BIN chunk path', () => {
        expect(parseSkinBinPath('data/characters/ahri/skins/skin1.bin'))
            .toEqual({ champion: 'ahri', skinId: 1 });
        expect(parseSkinBinPath('data/characters/ahri/skins/skin0.bin'))
            .toEqual({ champion: 'ahri', skinId: 0 });
        expect(parseSkinBinPath('DATA/Characters/Ahri/Skins/Skin86.bin'))
            .toEqual({ champion: 'ahri', skinId: 86 });
    });

    it('keeps the jade prefix — that is the character folder, not the WAD name', () => {
        expect(parseSkinBinPath('data/characters/jade_ahri/skins/skin301.bin'))
            .toEqual({ champion: 'jade_ahri', skinId: 301 });
    });

    it('accepts backslashes and a leading segment', () => {
        expect(parseSkinBinPath('data\\characters\\garen\\skins\\skin5.bin'))
            .toEqual({ champion: 'garen', skinId: 5 });
    });

    it('rejects anything that is not a skin BIN', () => {
        expect(parseSkinBinPath('data/characters/ahri/skins/root.bin')).toBeNull();
        expect(parseSkinBinPath('data/characters/ahri/ahri.bin')).toBeNull();
        expect(parseSkinBinPath('data/characters/ahri/skins/skin1.bin.json')).toBeNull();
        expect(parseSkinBinPath('assets/characters/ahri/skins/skin1.bin')).toBeNull();
        expect(parseSkinBinPath('data/characters/ahri/skins/skinabc.bin')).toBeNull();
        expect(parseSkinBinPath('')).toBeNull();
    });
});
