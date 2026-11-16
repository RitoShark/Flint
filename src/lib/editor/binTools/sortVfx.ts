import { scanLineBraces, type BraceCursor } from '../blockExtraction';
import { ABILITY_ORDER, classifyAbilityBucket, type AbilityBucket } from './vfxIndex';

export interface SortVfxResult {
    text: string;
    systems: number;
    moved: number;
    counts: Record<AbilityBucket, number>;
}

interface EntryBlock {
    start: number;
    end: number;
    bucket: AbilityBucket;
    sortName: string;
}

const ENTRIES_HEADER = /^\s*entries\s*:/;
const ENTRY_HEADER = /^\s*(?:"[^"]*"|0x[0-9a-fA-F]+)\s*=\s*([A-Za-z_]\w*|0x[0-9a-fA-F]+)\s*\{/;
const PARTICLE_NAME = /^\s*particleName\s*:\s*string\s*=\s*"([^"]*)"/;
const PARTICLE_PATH = /^\s*particlePath\s*:\s*string\s*=\s*"([^"]*)"/;

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function collectVfxBlocks(lines: string[]): EntryBlock[] | null {
    const blocks: EntryBlock[] = [];
    let cursor: BraceCursor = { inString: false };
    let depth = 0;
    let inEntries = false;
    let open: { start: number; isVfx: boolean; name: string | null; path: string | null } | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const depthBefore = depth;

        if (!inEntries && depthBefore === 0 && ENTRIES_HEADER.test(line)) inEntries = true;

        if (inEntries && depthBefore === 1 && !open && !cursor.inString) {
            const header = line.match(ENTRY_HEADER);
            if (header) open = { start: i, isVfx: header[1] === 'VfxSystemDefinitionData', name: null, path: null };
        } else if (open && open.isVfx && depthBefore === 2 && !cursor.inString) {
            if (open.name === null) {
                const value = line.match(PARTICLE_NAME)?.[1];
                if (value && value.trim()) open.name = value;
            }
            if (open.path === null) {
                const value = line.match(PARTICLE_PATH)?.[1];
                if (value && value.trim()) open.path = value;
            }
        }

        let closedAt = -1;
        const scanned = scanLineBraces(line, cursor, (ch, col) => {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            if (ch === '}' && open && depth === 1 && closedAt < 0) closedAt = col;
        });
        cursor = scanned;
        if (depth < 0) return null;
        if (closedAt >= 0 && line.slice(closedAt + 1, scanned.codeEnd).trim()) return null;

        if (open && depth <= 1) {
            if (open.isVfx) {
                const name = open.name ?? open.path ?? '';
                blocks.push({
                    start: open.start,
                    end: i,
                    bucket: classifyAbilityBucket(name),
                    sortName: asciiLower(name),
                });
            }
            open = null;
        }
        if (inEntries && depth === 0 && depthBefore > 0) inEntries = false;
    }

    if (open || depth !== 0 || cursor.inString) return null;
    return blocks;
}

export function sortVfxBySkill(text: string): SortVfxResult | null {
    const lines = text.split('\n');
    const slots = collectVfxBlocks(lines);
    if (!slots) return null;

    const counts = Object.fromEntries(ABILITY_ORDER.map((b) => [b, 0])) as Record<AbilityBucket, number>;
    for (const slot of slots) counts[slot.bucket]++;

    const rank = (b: AbilityBucket) => ABILITY_ORDER.indexOf(b);
    const sorted = slots
        .map((block, index) => ({ block, index }))
        .sort((a, b) =>
            rank(a.block.bucket) - rank(b.block.bucket)
            || (a.block.sortName < b.block.sortName ? -1 : a.block.sortName > b.block.sortName ? 1 : 0)
            || a.index - b.index)
        .map(({ block }) => block);

    const out: string[] = [];
    let cursor = 0;
    let moved = 0;
    slots.forEach((slot, i) => {
        const replacement = sorted[i];
        if (replacement !== slot) moved++;
        for (let line = cursor; line < slot.start; line++) out.push(lines[line]);
        for (let line = replacement.start; line <= replacement.end; line++) out.push(lines[line]);
        cursor = slot.end + 1;
    });
    for (let line = cursor; line < lines.length; line++) out.push(lines[line]);

    return { text: moved > 0 ? out.join('\n') : text, systems: slots.length, moved, counts };
}

