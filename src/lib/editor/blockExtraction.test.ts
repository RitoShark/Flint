import { describe, it, expect } from 'vitest';
import {
    findEnclosingBlock,
    reindentBlock,
    renameEmitterIfCollision,
    computeInsertPosition,
} from './blockExtraction';

const EMITTER_DOC = [
    '"VfxSystem/Foo" = VfxSystemDefinitionData {', // 1
    '    particleName: string = "Foo"',             // 2
    '    complexEmitterDefinitionData: list[embed] = {', // 3
    '        VfxEmitterDefinitionData {',            // 4
    '            emitterName: string = "EmitterA"',  // 5
    '            rate: f32 = 1.0',                    // 6
    '        }',                                      // 7
    '        VfxEmitterDefinitionData {',            // 8
    '            emitterName: string = "EmitterB"',  // 9
    '        }',                                      // 10
    '    }',                                          // 11
    '}',                                              // 12
].join('\n');

describe('findEnclosingBlock', () => {
    it('finds the emitter block from a cursor inside it', () => {
        const block = findEnclosingBlock(EMITTER_DOC, 6, ['VfxEmitterDefinitionData']);
        expect(block).not.toBeNull();
        expect(block!.className).toBe('VfxEmitterDefinitionData');
        expect(block!.startLine).toBe(4);
        expect(block!.endLine).toBe(7);
        expect(block!.blockText).toContain('EmitterA');
        expect(block!.blockText.trimEnd().endsWith('}')).toBe(true);
    });

    it('finds the second emitter when cursor is in it', () => {
        const block = findEnclosingBlock(EMITTER_DOC, 9, ['VfxEmitterDefinitionData']);
        expect(block!.startLine).toBe(8);
        expect(block!.blockText).toContain('EmitterB');
    });

    it('walks to the outermost VfxSystem when outermost=true', () => {
        const block = findEnclosingBlock(
            EMITTER_DOC,
            6,
            ['VfxSystemDefinitionData', 'VfxEmitterDefinitionData'],
            true,
        );
        expect(block!.className).toBe('VfxSystemDefinitionData');
        expect(block!.startLine).toBe(1);
        expect(block!.endLine).toBe(12);
    });

    it('returns the innermost match when outermost=false', () => {
        const block = findEnclosingBlock(
            EMITTER_DOC,
            6,
            ['VfxSystemDefinitionData', 'VfxEmitterDefinitionData'],
            false,
        );
        expect(block!.className).toBe('VfxEmitterDefinitionData');
    });

    it('returns null with no class match', () => {
        expect(findEnclosingBlock(EMITTER_DOC, 6, ['NoSuchClass'])).toBeNull();
    });

    it('is not fooled by a closing brace inside a string', () => {
        const doc = [
            'VfxEmitterDefinitionData {',           // 1
            '    label: string = "evil } brace"',   // 2
            '    rate: f32 = 1.0',                   // 3
            '}',                                     // 4
            'after: string = "x"',                  // 5
        ].join('\n');
        const block = findEnclosingBlock(doc, 3, ['VfxEmitterDefinitionData']);
        expect(block!.startLine).toBe(1);
        expect(block!.endLine).toBe(4); // not line 2 despite the `}` in the string
    });

    it('is not fooled by a closing brace inside a comment', () => {
        const doc = [
            'VfxEmitterDefinitionData {', // 1
            '    rate: f32 = 1.0 // trailing } comment', // 2
            '    # } stray',             // 3
            '}',                         // 4
        ].join('\n');
        const block = findEnclosingBlock(doc, 2, ['VfxEmitterDefinitionData']);
        expect(block!.endLine).toBe(4);
    });
});

describe('reindentBlock', () => {
    it('strips common indent and re-prefixes with target', () => {
        const src = [
            '        VfxEmitterDefinitionData {',
            '            emitterName: string = "A"',
            '        }',
        ].join('\n');
        const out = reindentBlock(src, '    ');
        expect(out).toBe(
            [
                '    VfxEmitterDefinitionData {',
                '        emitterName: string = "A"',
                '    }',
            ].join('\n'),
        );
    });

    it('keeps blank lines blank', () => {
        const src = ['    A {', '', '    }'].join('\n');
        expect(reindentBlock(src, '')).toBe(['A {', '', '}'].join('\n'));
    });
});

describe('renameEmitterIfCollision', () => {
    const target = 'emitterName: string = "EmitterA"\nemitterName: string = "EmitterA_copy"';

    it('renames on collision', () => {
        const block = 'VfxEmitterDefinitionData {\n    emitterName: string = "EmitterA"\n}';
        const out = renameEmitterIfCollision(block, target);
        // EmitterA and EmitterA_copy both exist -> next free is EmitterA_copy2
        expect(out).toContain('emitterName: string = "EmitterA_copy2"');
    });

    it('leaves name unchanged when no collision', () => {
        const block = 'VfxEmitterDefinitionData {\n    emitterName: string = "Fresh"\n}';
        const out = renameEmitterIfCollision(block, target);
        expect(out).toContain('emitterName: string = "Fresh"');
    });

    it('is a no-op when block has no emitterName', () => {
        const block = 'SomeOther {\n    x: f32 = 1\n}';
        expect(renameEmitterIfCollision(block, target)).toBe(block);
    });
});

describe('computeInsertPosition', () => {
    it('finds the enclosing list[embed] body and indents one level deeper', () => {
        // dropping at line 6 (inside EmitterA, inside the list at line 3)
        const pos = computeInsertPosition(EMITTER_DOC, 6);
        // list header indent is 4 spaces -> items at 8 spaces
        expect(pos.indent).toBe('        ');
        expect(pos.line).toBe(6);
    });

    it('falls back to drop-line indent when not inside a list', () => {
        const doc = ['top: string = "a"', 'next: string = "b"'].join('\n');
        const pos = computeInsertPosition(doc, 2);
        expect(pos.indent).toBe('');
        expect(pos.line).toBe(2);
    });
});
