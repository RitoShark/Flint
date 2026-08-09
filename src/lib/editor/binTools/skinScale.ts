export function parseSkinScale(text: string): { value: string; exists: boolean } {
    for (const line of text.split('\n')) {
        const t = line.trim().toLowerCase();
        if (t.startsWith('skinscale:')) {
            const colonIdx = line.indexOf(':');
            let vPart = line.substring(colonIdx + 1).trim();
            if (vPart.includes('=')) vPart = vPart.substring(vPart.indexOf('=') + 1).trim();
            return { value: vPart, exists: true };
        }
    }
    return { value: '1.0', exists: false };
}

export function applySkinScaleToText(text: string, newVal: string): string {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().toLowerCase().startsWith('skinscale:')) {
            const colonIdx = lines[i].indexOf(':');
            const afterColon = lines[i].substring(colonIdx + 1).trim();
            if (afterColon.includes('=')) {
                const eqIdx = lines[i].indexOf('=', colonIdx);
                lines[i] = lines[i].substring(0, eqIdx + 1) + ' ' + newVal;
            } else {
                lines[i] = lines[i].substring(0, colonIdx + 1) + ' ' + newVal;
            }
            return lines.join('\n');
        }
    }
    const out: string[] = [];
    let added = false;
    for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        if (!added && lines[i].includes('skinMeshProperties:') && lines[i].includes('SkinMeshDataProperties')) {
            let indent = '        ';
            if (i + 1 < lines.length) { const m = lines[i + 1].match(/^(\s*)/); if (m) indent = m[1]; }
            out.push(`${indent}skinScale: f32 = ${newVal}`);
            added = true;
        }
    }
    return out.join('\n');
}
