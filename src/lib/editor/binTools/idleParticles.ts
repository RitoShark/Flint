import { appendToList, quote } from './blockInsert';

export interface IdleEffectFields {
    effectKey: string;
    boneName: string;
    targetBoneName: string;
    effectName: string;
    position: [string, string, string];
}

const SKIN_PROPERTIES = /SkinCharacterDataProperties\s*\{/;

function num(value: string): string {
    const trimmed = value.trim();
    return trimmed === '' ? '0' : trimmed;
}

export function buildIdleEffect(fields: IdleEffectFields, indent: string): string[] {
    const inner = `${indent}    `;
    const [x, y, z] = fields.position;
    const lines = [`${indent}SkinCharacterDataProperties_CharacterIdleEffect {`];

    lines.push(`${inner}effectKey: hash = ${quote(fields.effectKey)}`);
    if (fields.boneName.trim()) lines.push(`${inner}boneName: string = ${quote(fields.boneName.trim())}`);
    if (fields.targetBoneName.trim()) lines.push(`${inner}targetBoneName: string = ${quote(fields.targetBoneName.trim())}`);
    if (fields.effectName.trim()) lines.push(`${inner}effectName: string = ${quote(fields.effectName.trim())}`);
    lines.push(`${inner}Position: vec3 = { ${num(x)}, ${num(y)}, ${num(z)} }`);
    lines.push(`${indent}}`);

    return lines;
}

export function insertIdleEffect(text: string, fields: IdleEffectFields): string {
    return appendToList(
        text,
        { name: 'idleParticlesEffects', decl: 'list[embed]', container: SKIN_PROPERTIES },
        (indent) => buildIdleEffect(fields, indent),
    );
}
