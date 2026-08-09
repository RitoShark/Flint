import { describe, it, expect } from 'vitest';
import { insertIdleEffect, type IdleEffectFields } from './idleParticles';
import { insertPersistentCondition, type PersistentVfxFields } from './persistentVfx';

const SKIN = [
    '"Characters/Ahri/Skins/Skin0" = SkinCharacterDataProperties {',
    '    championSkinName: string = "Ahri"',
    '}',
].join('\n');

const IDLE: IdleEffectFields = {
    effectKey: 'Ahri_Idle_Emblem',
    boneName: 'Spine3',
    targetBoneName: 'Tail1',
    effectName: 'R_Clavicle',
    position: ['0', '0', '-1'],
};

function vfxFields(over: Partial<PersistentVfxFields> = {}): PersistentVfxFields {
    return {
        effectKey: 'Aatrox_P_Ready',
        boneName: 'Weapon_Blade2',
        targetBoneName: '',
        scale: '',
        playSpeedModifier: '',
        showToOwnerOnly: false,
        attachToCamera: false,
        useDifferentKeyForOtherTeam: false,
        effectKeyForOtherTeam: '',
        submeshesToShow: '',
        submeshesToHide: '',
        forceRenderVfx: false,
        condition: null,
        ...over,
    };
}

describe('insertIdleEffect', () => {
    it('writes the schema shape into a new list', () => {
        const out = insertIdleEffect(SKIN, IDLE);
        expect(out).toContain('idleParticlesEffects: list[embed] = {');
        expect(out).toContain('SkinCharacterDataProperties_CharacterIdleEffect {');
        expect(out).toContain('effectKey: hash = "Ahri_Idle_Emblem"');
        expect(out).toContain('boneName: string = "Spine3"');
        expect(out).toContain('targetBoneName: string = "Tail1"');
        expect(out).toContain('effectName: string = "R_Clavicle"');
        expect(out).toContain('Position: vec3 = { 0, 0, -1 }');
    });

    it('omits blank optional fields rather than writing empty strings', () => {
        const out = insertIdleEffect(SKIN, { ...IDLE, boneName: '', effectName: '  ' });
        expect(out).not.toContain('boneName');
        expect(out).not.toContain('effectName');
        expect(out).toContain('effectKey: hash = "Ahri_Idle_Emblem"');
    });

    it('adds a second effect to the list it already created', () => {
        const once = insertIdleEffect(SKIN, IDLE);
        const twice = insertIdleEffect(once, { ...IDLE, effectKey: 'Second' });
        expect(twice.match(/idleParticlesEffects/g)).toHaveLength(1);
        expect(twice).toContain('"Ahri_Idle_Emblem"');
        expect(twice).toContain('"Second"');
    });
});

describe('insertPersistentCondition', () => {
    it('writes the PersistentVfxData block with only the filled fields', () => {
        const out = insertPersistentCondition(SKIN, vfxFields());
        expect(out).toContain('PersistentEffectConditions: list2[pointer] = {');
        expect(out).toContain('PersistentEffectConditionData {');
        expect(out).toContain('PersistentVfxs: list2[embed] = {');
        expect(out).toContain('PersistentVfxData {');
        expect(out).toContain('effectKey: hash = "Aatrox_P_Ready"');
        expect(out).not.toContain('Scale:');
        expect(out).not.toContain('ShowToOwnerOnly');
    });

    it('emits the booleans only when set', () => {
        const out = insertPersistentCondition(SKIN, vfxFields({
            showToOwnerOnly: true,
            attachToCamera: true,
            forceRenderVfx: true,
        }));
        expect(out).toContain('ShowToOwnerOnly: bool = true');
        expect(out).toContain('AttachToCamera: bool = true');
        expect(out).toContain('ForceRenderVfx: bool = true');
    });

    it('drops the other-team key unless the flag is on', () => {
        const off = insertPersistentCondition(SKIN, vfxFields({ effectKeyForOtherTeam: 'Other' }));
        expect(off).not.toContain('EffectKeyForOtherTeam');

        const on = insertPersistentCondition(SKIN, vfxFields({
            useDifferentKeyForOtherTeam: true,
            effectKeyForOtherTeam: 'Other',
        }));
        expect(on).toContain('UseDifferentKeyForOtherTeam: bool = true');
        expect(on).toContain('EffectKeyForOtherTeam: hash = "Other"');
    });

    it('splits submesh lists on commas and newlines', () => {
        const out = insertPersistentCondition(SKIN, vfxFields({
            submeshesToShow: 'Sword_02, Sword_02_Blade',
            submeshesToHide: 'Sword_01\nSword_vfx',
        }));
        expect(out).toContain('SubmeshesToShow: list2[hash] = { "Sword_02", "Sword_02_Blade" }');
        expect(out).toContain('SubmeshesToHide: list2[hash] = { "Sword_01", "Sword_vfx" }');
    });

    it('wraps a buff condition in AllTrueMaterialDriver', () => {
        const out = insertPersistentCondition(SKIN, vfxFields({
            condition: {
                spell: 'Characters/Aatrox/Spells/AatroxPassiveReady',
                scriptName: 'AatroxInCombat',
                deactivateEarlySeconds: '1',
                negate: false,
            },
        }));
        expect(out).toContain('OwnerCondition: pointer = AllTrueMaterialDriver {');
        expect(out).toContain('mDrivers: list[pointer] = {');
        expect(out).toContain('HasBuffDynamicMaterialBoolDriver {');
        expect(out).toContain('mScriptName: string = "AatroxInCombat"');
        expect(out).toContain('mDeactivateEarlySeconds: f32 = 1');
    });

    it('wraps a negated buff condition in NotMaterialDriver', () => {
        const out = insertPersistentCondition(SKIN, vfxFields({
            condition: {
                spell: 'Spell', scriptName: 'S', deactivateEarlySeconds: '', negate: true,
            },
        }));
        expect(out).toContain('OwnerCondition: pointer = NotMaterialDriver {');
        expect(out).toContain('mDriver: pointer = HasBuffDynamicMaterialBoolDriver {');
        expect(out).not.toContain('mDrivers:');
    });

    it('never invents a name for a field with no dictionary entry', () => {
        const out = insertPersistentCondition(SKIN, vfxFields({
            condition: { spell: 'S', scriptName: 'N', deactivateEarlySeconds: '1', negate: false },
        }));
        expect(out).not.toMatch(/0x149271dd|0x9dba9f88|0xeaf5370d|0x34262325/);
    });

    it('leaves a hand-written condition tree untouched when adding another block', () => {
        const hand = [
            '"x" = SkinCharacterDataProperties {',
            '    PersistentEffectConditions: list2[pointer] = {',
            '        PersistentEffectConditionData {',
            '            OwnerCondition: pointer = AnyTrueMaterialDriver {',
            '                mDrivers: list[pointer] = {',
            '                    SomeExoticDriver {',
            '                    }',
            '                }',
            '            }',
            '        }',
            '    }',
            '}',
        ].join('\n');
        const out = insertPersistentCondition(hand, vfxFields());
        expect(out).toContain('AnyTrueMaterialDriver {');
        expect(out).toContain('SomeExoticDriver {');
        expect(out).toContain('effectKey: hash = "Aatrox_P_Ready"');
    });
});
