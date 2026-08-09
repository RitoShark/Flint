import { scanLineBraces, type BraceCursor } from '../blockExtraction';

const INDENT = '    ';

/** Quote a ritobin string value, escaping backslashes and quotes. */
export function quote(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function indentOf(line: string): string {
    return line.match(/^(\s*)/)?.[1] ?? '';
}

/** Line index (0-based) of the `}` closing the block opened on `headerIdx`. */
function closingLine(lines: string[], headerIdx: number): number {
    let depth = 0;
    let started = false;
    let cursor: BraceCursor = { inString: false };

    for (let i = headerIdx; i < lines.length; i++) {
        let closedAt = -1;
        cursor = scanLineBraces(lines[i], cursor, (ch) => {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') {
                depth--;
                if (started && depth === 0 && closedAt === -1) closedAt = i;
            }
        });
        if (started && depth === 0) return closedAt === -1 ? i : closedAt;
    }
    return -1;
}

function findLine(lines: string[], pattern: RegExp): number {
    for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) return i;
    }
    return -1;
}

export interface ListTarget {
    /** Property name, e.g. `idleParticlesEffects`. */
    name: string;
    /** Type declaration, e.g. `list[embed]`. */
    decl: string;
    /** Header of the block the list belongs to when it has to be created. */
    container: RegExp;
}

/**
 * Append `entry` to `target.name`, creating the list inside `target.container`
 * when it does not exist yet. `entry` is built from the indent it will sit at.
 *
 * Returns the original text unchanged when the container is missing — the
 * caller surfaces that rather than writing a block somewhere arbitrary.
 */
export function appendToList(
    text: string,
    target: ListTarget,
    entry: (indent: string) => string[],
): string {
    const lines = text.split('\n');
    const listIdx = findLine(lines, new RegExp(`^\\s*${target.name}\\s*:`));

    if (listIdx !== -1) {
        const collapsed = /\{\s*\}\s*$/.test(lines[listIdx]);
        if (collapsed) {
            const listIndent = indentOf(lines[listIdx]);
            const body = entry(listIndent + INDENT);
            const opened = lines[listIdx].replace(/\{\s*\}\s*$/, '{');
            return [
                ...lines.slice(0, listIdx),
                opened,
                ...body,
                `${listIndent}}`,
                ...lines.slice(listIdx + 1),
            ].join('\n');
        }

        const closeIdx = closingLine(lines, listIdx);
        if (closeIdx === -1) return text;
        const firstChild = lines[listIdx + 1];
        const childIndent = firstChild?.trim()
            ? indentOf(firstChild)
            : indentOf(lines[listIdx]) + INDENT;
        return [
            ...lines.slice(0, closeIdx),
            ...entry(childIndent),
            ...lines.slice(closeIdx),
        ].join('\n');
    }

    const containerIdx = findLine(lines, target.container);
    if (containerIdx === -1) return text;

    const nextLine = lines[containerIdx + 1];
    const childIndent = nextLine?.trim()
        ? indentOf(nextLine)
        : indentOf(lines[containerIdx]) + INDENT;

    return [
        ...lines.slice(0, containerIdx + 1),
        `${childIndent}${target.name}: ${target.decl} = {`,
        ...entry(childIndent + INDENT),
        `${childIndent}}`,
        ...lines.slice(containerIdx + 1),
    ].join('\n');
}

export function hasProperty(text: string, name: string): boolean {
    return new RegExp(`^\\s*${name}\\s*:`, 'm').test(text);
}
