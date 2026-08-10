import { describe, it, expect } from 'vitest';
import { indexEntries, indexNavigable, indexVfxSystems, nextSystem, previousSystem } from './vfxIndex';

const BIN = [
    'entries: map[hash,embed] = {',
    '    "Ahri/Particles/Q_Mis" = VfxSystemDefinitionData {',
    '        particleName: string = "Q_Mis"',
    '        particlePath: string = "Ahri/Particles/Q_Mis"',
    '        complexEmitterDefinitionData: list[pointer] = {',
    '            VfxEmitterDefinitionData {',
    '                emitterName: string = "core"',
    '            }',
    '        }',
    '    }',
    '    "Ahri/Particles/W_Buf" = VfxSystemDefinitionData {',
    '        particleName: string = "W_Buf"',
    '    }',
    '    "Ahri/Particles/E_Hit" = VfxSystemDefinitionData {',
    '    }',
    '}',
].join('\n');

describe('indexVfxSystems', () => {
    it('finds every system in document order', () => {
        const systems = indexVfxSystems(BIN);
        expect(systems.map((s) => s.line)).toEqual([2, 11, 14]);
    });

    it('prefers particlePath, falls back to particleName, then the entry key', () => {
        const [q, w, e] = indexVfxSystems(BIN);
        expect(q.label).toBe('Ahri/Particles/Q_Mis');
        expect(w.label).toBe('W_Buf');
        expect(e.label).toBe('Ahri/Particles/E_Hit');
    });

    it('does not read a later system\'s path into an earlier one', () => {
        const systems = indexVfxSystems(BIN);
        expect(systems[1].label).not.toBe('Ahri/Particles/Q_Mis');
    });

    it('still indexes a file whose braces are unbalanced mid-edit', () => {
        const broken = 'x = VfxSystemDefinitionData {\n    particlePath: string = "a/b"\n';
        expect(indexVfxSystems(broken)).toHaveLength(1);
        expect(indexVfxSystems(broken)[0].label).toBe('a/b');
    });

    it('ignores a particlePath that appears inside a quoted string', () => {
        expect(indexVfxSystems('note: string = "VfxSystemDefinitionData {"')).toHaveLength(1);
    });
});

describe('navigation', () => {
    const systems = indexVfxSystems(BIN);

    it('steps forward and wraps at the end', () => {
        expect(nextSystem(systems, 1)!.line).toBe(2);
        expect(nextSystem(systems, 2)!.line).toBe(11);
        expect(nextSystem(systems, 14)!.line).toBe(2);
    });

    it('steps back and wraps at the start', () => {
        expect(previousSystem(systems, 14)!.line).toBe(11);
        expect(previousSystem(systems, 2)!.line).toBe(14);
    });

    it('visits every system exactly once per cycle', () => {
        const seen: number[] = [];
        let line = 0;
        for (let i = 0; i < systems.length; i++) {
            line = nextSystem(systems, line)!.line;
            seen.push(line);
        }
        expect(seen).toEqual(systems.map((s) => s.line));
    });
});

describe('indexEntries / indexNavigable', () => {
    const SKIN = [
        'entries: map[hash,embed] = {',
        '    "Characters/Evelynn/Skins/Skin0" = SkinCharacterDataProperties {',
        '        skinAudioProperties: embed = skinAudioProperties {',
        '            deep: embed = Nested {',
        '            }',
        '        }',
        '    }',
        '    "Characters/Evelynn/Skins/Skin0/Resources" = ResourceResolver {',
        '        resourceMap: map[hash,link] = {',
        '            "Evelynn_Q_Tar" = "Characters/Evelynn/Skins/Skin0/Particles/Q_Tar"',
        '        }',
        '    }',
        '}',
    ].join('\n');

    it('lists only top-level entry headers', () => {
        const entries = indexEntries(SKIN);
        expect(entries.map((e) => e.line)).toEqual([2, 8]);
        expect(entries[1].label).toBe('Characters/Evelynn/Skins/Skin0/Resources');
    });

    it('ignores a nested block and a quoted map value', () => {
        const labels = indexEntries(SKIN).map((e) => e.label);
        expect(labels).not.toContain('Evelynn_Q_Tar');
        expect(labels.some((l) => l.includes('Nested'))).toBe(false);
    });

    it('falls back to entries when a BIN has no VFX systems', () => {
        const nav = indexNavigable(SKIN);
        expect(nav.kind).toBe('entry');
        expect(nav.blocks).toHaveLength(2);
    });

    it('prefers VFX systems when the BIN has them', () => {
        const nav = indexNavigable(BIN);
        expect(nav.kind).toBe('system');
        expect(nav.blocks).toHaveLength(3);
    });
});
