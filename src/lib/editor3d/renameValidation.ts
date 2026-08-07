// Case-insensitive: FNV1a-32 of the lowercased name is what submesh-visibility events match on, so a collision makes one submesh unreachable.
export function validateSubmeshName(
    name: string,
    existing: string[],
    selfIndex: number | null,
): string | null {
    if (name.trim() === '') return 'Name cannot be empty.';
    const lower = name.toLowerCase();
    for (let i = 0; i < existing.length; i++) {
        if (i === selfIndex) continue;
        if (existing[i].toLowerCase() === lower) {
            return `A submesh named "${existing[i]}" already exists.`;
        }
    }
    return null;
}

// Case-insensitive: a joint's name is hashed into every .anm track and BIN bone-reference field the same way a submesh name is hashed into visibility events.
export function validateJointName(
    name: string,
    existing: string[],
    selfIndex: number | null,
): string | null {
    if (name.trim() === '') return 'Name cannot be empty.';
    const lower = name.toLowerCase();
    for (let i = 0; i < existing.length; i++) {
        if (i === selfIndex) continue;
        if (existing[i].toLowerCase() === lower) {
            return `A joint named "${existing[i]}" already exists.`;
        }
    }
    return null;
}
