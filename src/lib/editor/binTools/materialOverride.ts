export type MaterialOverrideKind = 'texture' | 'material';

export function ensureMaterialOverride(text: string): string {
    if (text.includes('materialOverride:')) return text;
    const lines = text.split('\n');
    const out: string[] = [];
    let added = false;
    for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        if (!added && lines[i].includes('skinMeshProperties:') && lines[i].includes('SkinMeshDataProperties')) {
            let indent = '        ';
            if (i + 1 < lines.length) { const m = lines[i + 1].match(/^(\s*)/); if (m) indent = m[1]; }
            out.push(`${indent}materialOverride: list[embed] = {`);
            out.push(`${indent}}`);
            added = true;
        }
    }
    return out.join('\n');
}

export function insertMaterialOverrideEntry(
    text: string,
    path: string,
    submesh: string,
    kind: MaterialOverrideKind,
): string {
    const content = ensureMaterialOverride(text);
    const lines = content.split('\n');
    let matIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('materialOverride:') && lines[i].includes('list[embed]')) { matIdx = i; break; }
    }
    if (matIdx === -1) return content;

    let depth = 0;
    let insertIdx = -1;
    for (let j = matIdx; j < lines.length; j++) {
        for (const c of lines[j]) { if (c === '{') depth++; else if (c === '}') depth--; }
        if (depth === 0 && j > matIdx) { insertIdx = j; break; }
    }
    if (insertIdx === -1) return content;

    let indent = '            ';
    if (matIdx + 1 < lines.length && lines[matIdx + 1].trim()) {
        const m = lines[matIdx + 1].match(/^(\s*)/); if (m) indent = m[1];
    }
    // `texture` is one of the fields Riot retyped to `file`; a string here is a
    // reference the current client no longer resolves.
    const propType = kind === 'texture' ? 'file' : 'link';
    const propName = kind === 'texture' ? 'texture' : 'material';
    const entry = [
        `${indent}SkinMeshDataProperties_MaterialOverride {`,
        `${indent}    ${propName}: ${propType} = "${path}"`,
        `${indent}    Submesh: string = "${submesh}"`,
        `${indent}}`,
    ];
    return [...lines.slice(0, insertIdx), ...entry, ...lines.slice(insertIdx)].join('\n');
}
