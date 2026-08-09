import { scanLineBraces, type BraceCursor } from '../blockExtraction';

export interface VfxSystemEntry {
    /** 1-based line of the `VfxSystemDefinitionData {` header. */
    line: number;
    label: string;
    /** Entry key when the system is a top-level entry, else null. */
    key: string | null;
}

const SYSTEM_HEADER = /VfxSystemDefinitionData\s*\{/;
const ENTRY_KEY = /"([^"]+)"\s*=\s*VfxSystemDefinitionData/;
const PARTICLE_PATH = /\bparticlePath\s*:\s*string\s*=\s*"([^"]*)"/;
const PARTICLE_NAME = /\bparticleName\s*:\s*string\s*=\s*"([^"]*)"/;

/**
 * Every `VfxSystemDefinitionData` block in the file, in document order.
 *
 * Lexical on purpose: the index has to stay correct while the document is
 * mid-edit and temporarily unparseable, so it never goes through the BIN tree.
 */
export function indexVfxSystems(text: string): VfxSystemEntry[] {
    const lines = text.split('\n');
    const found: VfxSystemEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (!SYSTEM_HEADER.test(lines[i])) continue;
        const key = lines[i].match(ENTRY_KEY)?.[1] ?? null;
        found.push({
            line: i + 1,
            label: readLabel(lines, i) ?? key ?? `System @ ${i + 1}`,
            key,
        });
    }

    return found;
}

/** The system's `particlePath`, else its `particleName`, read from its own block. */
function readLabel(lines: string[], headerIdx: number): string | null {
    let depth = 0;
    let started = false;
    let cursor: BraceCursor = { inString: false };
    let name: string | null = null;

    for (let i = headerIdx; i < lines.length; i++) {
        if (i > headerIdx) {
            const path = lines[i].match(PARTICLE_PATH)?.[1];
            if (path) return path;
            if (!name) name = lines[i].match(PARTICLE_NAME)?.[1] ?? null;
        }

        cursor = scanLineBraces(lines[i], cursor, (ch) => {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        });

        if (started && depth <= 0) break;
    }

    return name;
}

/** The next system after `line`, wrapping at the end. */
export function nextSystem(systems: VfxSystemEntry[], line: number): VfxSystemEntry | null {
    if (systems.length === 0) return null;
    return systems.find((s) => s.line > line) ?? systems[0];
}

/** The previous system before `line`, wrapping at the start. */
export function previousSystem(systems: VfxSystemEntry[], line: number): VfxSystemEntry | null {
    if (systems.length === 0) return null;
    for (let i = systems.length - 1; i >= 0; i--) {
        if (systems[i].line < line) return systems[i];
    }
    return systems[systems.length - 1];
}
