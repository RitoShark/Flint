import { scanLineBraces, type BraceCursor } from '../blockExtraction';

export interface VfxSystemEntry {
    /** 1-based line of the `VfxSystemDefinitionData {` header. */
    line: number;
    label: string;
    /** Entry key when the system is a top-level entry, else null. */
    key: string | null;
    bucket?: AbilityBucket;
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
        const { path, name } = readNames(lines, i);
        found.push({
            line: i + 1,
            label: path ?? name ?? key ?? `System @ ${i + 1}`,
            key,
            bucket: classifyAbilityBucket(name ?? path),
        });
    }

    return found;
}

/** The system's `particlePath` and `particleName`, read from its own block. */
function readNames(lines: string[], headerIdx: number): { path: string | null; name: string | null } {
    let depth = 0;
    let started = false;
    let cursor: BraceCursor = { inString: false };
    let path: string | null = null;
    let name: string | null = null;

    for (let i = headerIdx; i < lines.length; i++) {
        if (i > headerIdx && depth === 1 && !cursor.inString) {
            if (!path) path = nonBlank(lines[i].match(PARTICLE_PATH)?.[1]);
            if (!name) name = nonBlank(lines[i].match(PARTICLE_NAME)?.[1]);
            if (path && name) break;
        }

        cursor = scanLineBraces(lines[i], cursor, (ch) => {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        });

        if (started && depth <= 0) break;
    }

    return { path, name };
}

function nonBlank(value: string | undefined): string | null {
    return value && value.trim() ? value : null;
}

export type AbilityBucket = 'passive' | 'basicAttack' | 'q' | 'w' | 'e' | 'r' | 'misc';

export const ABILITY_ORDER: readonly AbilityBucket[] = ['passive', 'basicAttack', 'q', 'w', 'e', 'r', 'misc'];

export const ABILITY_LABELS: Record<AbilityBucket, string> = {
    passive: 'Passive',
    basicAttack: 'Basic Attack',
    q: 'Q',
    w: 'W',
    e: 'E',
    r: 'R',
    misc: 'Misc',
};

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const isUpper = (ch: string) => ch >= 'A' && ch <= 'Z';
const isLower = (ch: string) => ch >= 'a' && ch <= 'z';
const isAlnum = (ch: string) => isDigit(ch) || isUpper(ch) || isLower(ch);
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export function nameTokens(name: string): string[] {
    const tokens: string[] = [];
    let current = '';

    for (let i = 0; i < name.length; i++) {
        const ch = name[i];
        if (!isAlnum(ch)) {
            if (current) { tokens.push(asciiLower(current)); current = ''; }
            continue;
        }

        const prev = current ? current[current.length - 1] : undefined;
        const next = name[i + 1];
        const camel = prev !== undefined && isLower(prev) && isUpper(ch);
        const acronym = prev !== undefined && isUpper(prev) && isUpper(ch) && next !== undefined && isLower(next);
        const number = (prev !== undefined && isDigit(prev)) !== isDigit(ch);

        if (current && (camel || acronym || number)) {
            tokens.push(asciiLower(current));
            current = '';
        }
        current += ch;
    }

    if (current) tokens.push(asciiLower(current));
    return tokens;
}

export function classifyAbilityBucket(label: string | null | undefined): AbilityBucket {
    if (!label) return 'misc';
    const tokens = nameTokens(label);
    const has = (value: string) => tokens.includes(value);
    const pair = (left: string, right: string) =>
        tokens.some((t, i) => t === left && tokens[i + 1] === right);
    const spell = (n: string) =>
        tokens.some((t, i) => (t === 'spell' || t === 'ability' || t === 'slot') && tokens[i + 1] === n);

    if (has('passive') || has('trait') || has('p')) return 'passive';
    if (has('ba') || has('aa') || has('basicattack') || pair('basic', 'attack')
        || pair('crit', 'attack') || has('attack') || has('crit')) return 'basicAttack';
    if (has('q') || spell('1')) return 'q';
    if (has('w') || spell('2')) return 'w';
    if (has('e') || spell('3')) return 'e';
    if (has('r') || has('ult') || has('ultimate') || spell('4')) return 'r';
    return 'misc';
}

/** A top-level entry header: `    "Key" = ClassName {`. */
const ENTRY_HEADER = /^(\s*)"([^"]+)"\s*=\s*[A-Za-z_][\w]*\s*\{/;

/** Max indent an entry header may carry to count as top level (ritobin uses 4). */
const TOP_LEVEL_INDENT = 4;

export function indexEntries(text: string): VfxSystemEntry[] {
    const lines = text.split('\n');
    const found: VfxSystemEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(ENTRY_HEADER);
        if (!match || match[1].length > TOP_LEVEL_INDENT) continue;
        found.push({ line: i + 1, label: match[2], key: match[2] });
    }

    return found;
}

export type NavigableKind = 'system' | 'entry';

/**
 * What the editor's sticky bar steps through.
 *
 * VFX systems when the file has any; otherwise the top-level entries, because a
 * skin BIN holds no `VfxSystemDefinitionData` at all (only `resourceMap` links
 * to systems defined in the particles BIN) and would otherwise offer nothing to
 * leap between.
 */
export function indexNavigable(text: string): { blocks: VfxSystemEntry[]; kind: NavigableKind } {
    const systems = indexVfxSystems(text);
    if (systems.length > 0) return { blocks: systems, kind: 'system' };
    return { blocks: indexEntries(text), kind: 'entry' };
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
