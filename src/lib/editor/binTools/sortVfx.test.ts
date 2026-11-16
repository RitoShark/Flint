import { describe, it, expect } from 'vitest';
import { sortVfxBySkill } from './sortVfx';
import { classifyAbilityBucket, indexVfxSystems } from './vfxIndex';

const system = (key: string, name: string) => [
    `    "${key}" = VfxSystemDefinitionData {`,
    `        particleName: string = "${name}"`,
    '        complexEmitterDefinitionData: list[pointer] = {',
    '            VfxEmitterDefinitionData {',
    '                emitterName: string = "core"',
    '            }',
    '        }',
    '    }',
];

const BIN = [
    '#PROP_text',
    'type: string = "PROP"',
    'linked: list[string] = {',
    '    "DATA/Characters/Lux/Lux.bin"',
    '}',
    'entries: map[hash,embed] = {',
    ...system('Lux/R', 'Lux_Base_R_Beam'),
    '    "Lux/Resolver" = ResourceResolver {',
    '        resourceMap: map[hash,link] = {}',
    '    }',
    ...system('Lux/Q', 'Lux_Base_Q_Mis'),
    ...system('Lux/P', 'Lux_Base_P_Shield'),
    ...system('Lux/Recall', 'Qiyana_Recall'),
    '    0x1234abcd = VfxSystemDefinitionData {',
    '        particleName: string = "Lux_Base_BA_Hit"',
    '    }',
    '}',
].join('\n');

const order = (text: string) =>
    [...text.matchAll(/particleName: string = "([^"]+)"/g)].map((m) => m[1]);

describe('classifyAbilityBucket', () => {
    it('matches the Rust classifier on common Riot and modder names', () => {
        expect(classifyAbilityBucket('Lux_Base_P_Shield')).toBe('passive');
        expect(classifyAbilityBucket('Jade_Katarina_BasicAttack1')).toBe('basicAttack');
        expect(classifyAbilityBucket('Lux_Base_Q_tar')).toBe('q');
        expect(classifyAbilityBucket('Lux_Spell2_Mis')).toBe('w');
        expect(classifyAbilityBucket('Lux_Base_E_AOE')).toBe('e');
        expect(classifyAbilityBucket('Lux_Ult_Beam')).toBe('r');
        expect(classifyAbilityBucket('Qiyana_Recall')).toBe('misc');
        expect(classifyAbilityBucket('Rumble_Emote')).toBe('misc');
        expect(classifyAbilityBucket(null)).toBe('misc');
    });
});

describe('sortVfxBySkill', () => {
    it('orders systems by skill and keeps other entries in place', () => {
        const result = sortVfxBySkill(BIN)!;
        expect(order(result.text)).toEqual([
            'Lux_Base_P_Shield',
            'Lux_Base_BA_Hit',
            'Lux_Base_Q_Mis',
            'Lux_Base_R_Beam',
            'Qiyana_Recall',
        ]);
        const lines = result.text.split('\n');
        expect(lines.indexOf('    "Lux/Resolver" = ResourceResolver {'))
            .toBe(BIN.split('\n').indexOf('    "Lux/Resolver" = ResourceResolver {'));
        expect(result.systems).toBe(5);
        expect(result.counts.passive).toBe(1);
        expect(result.counts.misc).toBe(1);
    });

    it('preserves every line and is idempotent', () => {
        const once = sortVfxBySkill(BIN)!;
        expect(once.text.split('\n').sort()).toEqual(BIN.split('\n').sort());
        const twice = sortVfxBySkill(once.text)!;
        expect(twice.moved).toBe(0);
        expect(twice.text).toBe(once.text);
    });

    it('refuses to reorder unbalanced text', () => {
        expect(sortVfxBySkill(BIN.slice(0, -2))).toBeNull();
    });

    it('refuses entries sharing a closing line instead of moving unrelated content', () => {
        expect(sortVfxBySkill(BIN.replace('    }\n    "Lux/Resolver"', '    } "Lux/Resolver"'))).toBeNull();
        expect(sortVfxBySkill(BIN.replace(/\n}$/, ' }'))).toBeNull();
    });

    it('keeps CRLF, comments, and braces inside strings intact', () => {
        const text = BIN.replace('Lux_Base_R_Beam', 'Lux_Base_R_{Beam}')
            .replace('    "Lux/Resolver"', '    # keep this comment\n    "Lux/Resolver"')
            .replace(/\n/g, '\r\n');
        const result = sortVfxBySkill(text)!;
        expect(result.text.split('\r\n').sort()).toEqual(text.split('\r\n').sort());
        expect(sortVfxBySkill(result.text)!.moved).toBe(0);
    });

    it('ignores particleName on nested blocks', () => {
        const text = [
            'entries: map[hash,embed] = {',
            '    "B" = VfxSystemDefinitionData {',
            '        nested: embed = Thing {',
            '            particleName: string = "A_P_Fake"',
            '        }',
            '        particleName: string = "B_Q"',
            '    }',
            '    "A" = VfxSystemDefinitionData {',
            '        particleName: string = "A_P"',
            '    }',
            '}',
        ].join('\n');
        const result = sortVfxBySkill(text)!;
        expect(result.text.indexOf('"A" =')).toBeLessThan(result.text.indexOf('"B" ='));
        expect(indexVfxSystems(text)[0].bucket).toBe('q');
    });
});

