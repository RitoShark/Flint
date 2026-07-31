import { describe, it, expect } from 'vitest';
import {
    findEnclosingBlock,
    reindentBlock,
    renameEmitterIfCollision,
    computeInsertPosition,
    extractAssetPaths,
    scanLineBraces,
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
        expect(block!.endLine).toBe(4);
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
        const pos = computeInsertPosition(EMITTER_DOC, 6);
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

describe('extractAssetPaths', () => {
    const VFX_BLOCK = [
        'VfxEmitterDefinitionData {',
        '    emitterName: string = "Smoke"',
        '    particleColorTexture: string = "ASSETS/Characters/Aatrox/Skins/Skin0/Particles/smoke.dds"',
        '    birthScale0: vec3 = { 1, 1, 1 }',
        '    mTexture: string = "ASSETS/Characters/Aatrox/Skins/Skin0/Particles/mask.tex"',
        '    mesh: string = "ASSETS/Characters/Aatrox/Skins/Skin0/aatrox.scb"',
        '    soundOnPlay: string = "ASSETS/Sounds/Wwise2016/SFX/Characters/Aatrox/skin0_sfx_audio.bnk"',
        '    label: string = "no slash so not a path"',
        '    plainName: string = "JustAName"',
        '}',
    ].join('\n');

    it('extracts texture / mesh / sound paths in order', () => {
        expect(extractAssetPaths(VFX_BLOCK)).toEqual([
            'ASSETS/Characters/Aatrox/Skins/Skin0/Particles/smoke.dds',
            'ASSETS/Characters/Aatrox/Skins/Skin0/Particles/mask.tex',
            'ASSETS/Characters/Aatrox/Skins/Skin0/aatrox.scb',
            'ASSETS/Sounds/Wwise2016/SFX/Characters/Aatrox/skin0_sfx_audio.bnk',
        ]);
    });

    it('ignores non-asset strings and bare names', () => {
        const out = extractAssetPaths(VFX_BLOCK);
        expect(out).not.toContain('no slash so not a path');
        expect(out).not.toContain('JustAName');
    });

    it('de-duplicates repeated references', () => {
        const doc = [
            'a: string = "ASSETS/x/foo.dds"',
            'b: string = "ASSETS/x/foo.dds"',
            'c: string = "ASSETS/x/bar.tex"',
        ].join('\n');
        expect(extractAssetPaths(doc)).toEqual(['ASSETS/x/foo.dds', 'ASSETS/x/bar.tex']);
    });

    it('returns empty array for a block with no asset paths', () => {
        const doc = 'VfxEmitterDefinitionData {\n    rate: f32 = 1.0\n}';
        expect(extractAssetPaths(doc)).toEqual([]);
    });

    it('accepts uppercase extensions', () => {
        expect(extractAssetPaths('t: string = "ASSETS/X/Y.DDS"')).toEqual(['ASSETS/X/Y.DDS']);
    });
});

describe('scanLineBraces', () => {
    it('reports codeEnd at the comment marker', () => {
        const r = scanLineBraces('    foo: u32 = 1 # trailing note', { inString: false }, () => {});
        expect(r.codeEnd).toBe(17);
    });

    it('reports codeEnd at line length when there is no comment', () => {
        const line = '    values: list[vec3] = {';
        const r = scanLineBraces(line, { inString: false }, () => {});
        expect(r.codeEnd).toBe(line.length);
    });

    it('ignores a # inside a string', () => {
        const line = '    name: string = "a#b"';
        const r = scanLineBraces(line, { inString: false }, () => {});
        expect(r.codeEnd).toBe(line.length);
    });

    it('still reports braces with their columns', () => {
        const seen: Array<[string, number]> = [];
        scanLineBraces('{ 1, 2, 3 }', { inString: false }, (ch, col) => seen.push([ch, col]));
        expect(seen).toEqual([['{', 0], ['}', 10]]);
    });

    /*
     * rs_bin's printer (crates/rs_bin/src/text/print.rs) emits a literal
     * backslash as `\\`. A string ending in one backslash is therefore
     * printed as `"...\\"`, where the closing quote is preceded by an EVEN
     * run of backslashes (an escaped backslash, not an escaped quote) and
     * really does terminate the string.
     */
    it('treats a string ending in an escaped backslash as terminated', () => {
        const line = '    s: string = "a\\\\"'; // source text: s: string = "a\\"
        const r = scanLineBraces(line, { inString: false }, () => {});
        expect(r.inString).toBe(false);
    });

    it('treats a string ending in just a backslash-quote the same way', () => {
        const line = '    s: string = "\\\\"'; // source text: s: string = "\\"
        const r = scanLineBraces(line, { inString: false }, () => {});
        expect(r.inString).toBe(false);
    });

    it('still honours an escaped quote (odd backslash run) as non-terminating', () => {
        const line = '    s: string = "say \\"hi\\""'; // source text: s: string = "say \"hi\""
        const r = scanLineBraces(line, { inString: false }, () => {});
        expect(r.inString).toBe(false);
    });

    it('leaves inString true for a genuinely unterminated string', () => {
        const line = '    s: string = "unterminated';
        const r = scanLineBraces(line, { inString: false }, () => {});
        expect(r.inString).toBe(true);
    });
});
