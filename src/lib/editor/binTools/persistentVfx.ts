import { appendToList, quote } from './blockInsert';

export interface BuffConditionFields {
    spell: string;
    scriptName: string;
    deactivateEarlySeconds: string;
    /** Wrap the driver in `NotMaterialDriver` instead of `AllTrueMaterialDriver`. */
    negate: boolean;
}

export interface PersistentVfxFields {
    effectKey: string;
    boneName: string;
    targetBoneName: string;
    scale: string;
    playSpeedModifier: string;
    showToOwnerOnly: boolean;
    attachToCamera: boolean;
    useDifferentKeyForOtherTeam: boolean;
    effectKeyForOtherTeam: string;
    submeshesToShow: string;
    submeshesToHide: string;
    forceRenderVfx: boolean;
    condition: BuffConditionFields | null;
}

const SKIN_PROPERTIES = /SkinCharacterDataProperties\s*\{/;

function hashList(raw: string): string[] {
    return raw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/** `<prefix>HasBuffDynamicMaterialBoolDriver { … }`, indented under `indent`. */
function buffDriver(condition: BuffConditionFields, indent: string, prefix = ''): string[] {
    const inner = `${indent}    `;
    const lines = [`${indent}${prefix}HasBuffDynamicMaterialBoolDriver {`];
    if (condition.spell.trim()) lines.push(`${inner}Spell: hash = ${quote(condition.spell.trim())}`);
    if (condition.scriptName.trim()) lines.push(`${inner}mScriptName: string = ${quote(condition.scriptName.trim())}`);
    if (condition.deactivateEarlySeconds.trim()) {
        lines.push(`${inner}mDeactivateEarlySeconds: f32 = ${condition.deactivateEarlySeconds.trim()}`);
    }
    lines.push(`${indent}}`);
    return lines;
}

function ownerCondition(condition: BuffConditionFields, indent: string): string[] {
    const inner = `${indent}    `;
    if (condition.negate) {
        return [
            `${indent}OwnerCondition: pointer = NotMaterialDriver {`,
            ...buffDriver(condition, inner, 'mDriver: pointer = '),
            `${indent}}`,
        ];
    }
    return [
        `${indent}OwnerCondition: pointer = AllTrueMaterialDriver {`,
        `${inner}mDrivers: list[pointer] = {`,
        ...buffDriver(condition, `${inner}    `),
        `${inner}}`,
        `${indent}}`,
    ];
}

export function buildPersistentCondition(fields: PersistentVfxFields, indent: string): string[] {
    const l1 = `${indent}    `;
    const l2 = `${l1}    `;
    const l3 = `${l2}    `;
    const lines = [`${indent}PersistentEffectConditionData {`];

    if (fields.condition) lines.push(...ownerCondition(fields.condition, l1));

    lines.push(`${l1}PersistentVfxs: list2[embed] = {`);
    lines.push(`${l2}PersistentVfxData {`);
    lines.push(`${l3}effectKey: hash = ${quote(fields.effectKey)}`);
    if (fields.boneName.trim()) lines.push(`${l3}boneName: string = ${quote(fields.boneName.trim())}`);
    if (fields.targetBoneName.trim()) lines.push(`${l3}targetBoneName: string = ${quote(fields.targetBoneName.trim())}`);
    if (fields.scale.trim()) lines.push(`${l3}Scale: f32 = ${fields.scale.trim()}`);
    if (fields.playSpeedModifier.trim()) lines.push(`${l3}PlaySpeedModifier: f32 = ${fields.playSpeedModifier.trim()}`);
    if (fields.showToOwnerOnly) lines.push(`${l3}ShowToOwnerOnly: bool = true`);
    if (fields.attachToCamera) lines.push(`${l3}AttachToCamera: bool = true`);
    if (fields.useDifferentKeyForOtherTeam) {
        lines.push(`${l3}UseDifferentKeyForOtherTeam: bool = true`);
        if (fields.effectKeyForOtherTeam.trim()) {
            lines.push(`${l3}EffectKeyForOtherTeam: hash = ${quote(fields.effectKeyForOtherTeam.trim())}`);
        }
    }
    lines.push(`${l2}}`);
    lines.push(`${l1}}`);

    const show = hashList(fields.submeshesToShow);
    if (show.length > 0) {
        lines.push(`${l1}SubmeshesToShow: list2[hash] = { ${show.map(quote).join(', ')} }`);
    }
    const hide = hashList(fields.submeshesToHide);
    if (hide.length > 0) {
        lines.push(`${l1}SubmeshesToHide: list2[hash] = { ${hide.map(quote).join(', ')} }`);
    }
    if (fields.forceRenderVfx) lines.push(`${l1}ForceRenderVfx: bool = true`);

    lines.push(`${indent}}`);
    return lines;
}

export function insertPersistentCondition(text: string, fields: PersistentVfxFields): string {
    return appendToList(
        text,
        { name: 'PersistentEffectConditions', decl: 'list2[pointer]', container: SKIN_PROPERTIES },
        (indent) => buildPersistentCondition(fields, indent),
    );
}
