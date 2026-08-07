/**
 * Validate a submesh name against the rest of the mesh. Returns an error string,
 * or `null` when the name is usable.
 *
 * Names are the key the skin BIN references geometry by (and FNV1a-32 of the
 * lowercased name is what submesh-visibility events match on), so a collision
 * silently makes one of the two unreachable. Comparison is case-insensitive for
 * the same reason.
 *
 * `selfIndex` is the index being renamed — pass `null` for duplicate/paste,
 * where the name must be free against every existing submesh.
 */
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

/**
 * Same shape as `validateSubmeshName`, worded for joints. A joint's name is
 * hashed into every `.anm` track and into BIN bone-reference fields the same
 * way a submesh name is hashed into visibility events, so the same
 * case-insensitive-collision rule applies.
 */
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
